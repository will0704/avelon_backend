// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./lib/Harness.sol";
import "../contracts/AvelonLending.sol";
import "../contracts/CollateralManager.sol";

/**
 * Covers the stake model: a loan is deliberately under-secured, so liquidation
 * keys off default or off an off-chain value shortfall, never off the on-chain
 * ETH-over-ETH ratio.
 */
contract CollateralManagerTest is Harness {
    AvelonLending internal lending;
    CollateralManager internal manager;

    address internal constant TREASURY = 0x1111111111111111111111111111111111111111;
    address internal constant BORROWER = 0x2222222222222222222222222222222222222222;

    uint128 internal constant PRINCIPAL = 10 ether;
    uint128 internal constant STAKE = 3.5 ether;   // 35%
    uint16 internal constant RATE_BPS = 1000;      // 10%
    uint32 internal constant DURATION = 30 days;

    function setUp() public {
        // This contract owns both, standing in for the backend signer
        lending = new AvelonLending(TREASURY);
        manager = new CollateralManager();

        lending.setCollateralManager(address(manager));
        manager.setLendingContract(address(lending));

        vm.deal(BORROWER, 100 ether);
    }

    function _activeLoan() internal returns (uint32 loanId) {
        loanId = lending.createLoan(BORROWER, PRINCIPAL, STAKE, RATE_BPS, DURATION);
        vm.prank(BORROWER);
        manager.depositCollateral{value: STAKE}(loanId);
    }

    // ── the 35% stake is allowed at all ──────────────────────────────────

    function test_DefaultsAreTheStakeModel() public view {
        assertEq(manager.minCollateralRatio(), 3500, "min stake");
        assertEq(manager.warningCollateralRatio(), 4000, "warning stake");
    }

    function test_SetCollateralRatiosAcceptsSubHundredStake() public {
        manager.setCollateralRatios(3500, 4000);
        assertEq(manager.minCollateralRatio(), 3500, "min stake after set");
    }

    function test_SetCollateralRatiosStillRejectsNearZero() public {
        vm.expectRevert(CollateralManager.MinRatioTooLow.selector);
        manager.setCollateralRatios(100, 200);
    }

    function test_DepositAtStakeActivatesLoan() public {
        uint32 loanId = _activeLoan();

        (, AvelonLending.LoanStatus status) = lending.getLoanBorrowerAndStatus(loanId);
        assertEq(uint8(status), 1, "loan should be Active");
        assertEq(manager.getCollateral(loanId), STAKE, "stake recorded");
        assertTrue(manager.isCollateralLocked(loanId), "stake locked");
    }

    // ── liquidation triggers ─────────────────────────────────────────────

    function test_LiquidateRevertsWhenCurrentAndNotOverdue() public {
        uint32 loanId = _activeLoan();

        vm.expectRevert(CollateralManager.LoanNotOverdue.selector);
        manager.liquidate(loanId, CollateralManager.LiquidationReason.Default, 0);
    }

    function test_LiquidateOnDefaultSendsStakeToTreasury() public {
        uint32 loanId = _activeLoan();
        uint256 balanceBefore = TREASURY.balance;

        vm.warp(block.timestamp + DURATION + 1 days);
        assertTrue(lending.isOverdue(loanId), "loan should be overdue");

        manager.liquidate(loanId, CollateralManager.LiquidationReason.Default, 0);

        // The whole stake moves; the 5% split is recorded in the event and
        // attributed off-chain, same as the interest split
        assertEq(TREASURY.balance - balanceBefore, STAKE, "treasury did not receive the stake");
        assertEq(address(manager).balance, 0, "stake stranded in the manager");
        assertEq(manager.getCollateral(loanId), 0, "stake not cleared");
        assertFalse(manager.isCollateralLocked(loanId), "stake still locked");

        (, AvelonLending.LoanStatus status) = lending.getLoanBorrowerAndStatus(loanId);
        assertEq(uint8(status), 3, "loan should be Liquidated");
    }

    function test_LiquidateOnShortfallSucceedsBelowMinRatio() public {
        uint32 loanId = _activeLoan();
        uint256 balanceBefore = TREASURY.balance;

        // Not overdue — this branch is the off-chain fiat valuation
        manager.liquidate(loanId, CollateralManager.LiquidationReason.Shortfall, 3000);

        assertEq(TREASURY.balance - balanceBefore, STAKE, "treasury did not receive the stake");
        (, AvelonLending.LoanStatus status) = lending.getLoanBorrowerAndStatus(loanId);
        assertEq(uint8(status), 3, "loan should be Liquidated");
    }

    function test_LiquidateOnShortfallRevertsWhenRatioHealthy() public {
        uint32 loanId = _activeLoan();

        vm.expectRevert(CollateralManager.CollateralRatioHealthy.selector);
        manager.liquidate(loanId, CollateralManager.LiquidationReason.Shortfall, 3600);
    }

    function test_LiquidateEmitsReasonAndObservedRatio() public {
        uint32 loanId = _activeLoan();
        uint128 penalty = uint128((uint256(STAKE) * manager.liquidationPenalty()) / 10000);

        vm.expectEmit(true, false, false, true, address(manager));
        emit CollateralManager.CollateralLiquidated(
            loanId,
            STAKE - penalty,
            penalty,
            CollateralManager.LiquidationReason.Shortfall,
            2800
        );
        manager.liquidate(loanId, CollateralManager.LiquidationReason.Shortfall, 2800);
    }

    // ── the honest path is unchanged ─────────────────────────────────────

    function test_FullRepaymentReturnsStakeToBorrower() public {
        uint32 loanId = _activeLoan();

        (uint128 principalOwed, uint128 interestOwed) = lending.getLoanOwed(loanId);
        lending.recordRepayment(loanId, principalOwed + interestOwed);

        uint256 balanceBefore = BORROWER.balance;
        manager.releaseCollateral(loanId);

        assertEq(BORROWER.balance - balanceBefore, STAKE, "borrower did not get the stake back");
        assertFalse(manager.isCollateralLocked(loanId), "stake still locked");
    }

    // ── risk view ────────────────────────────────────────────────────────

    function test_IsAtRiskFlagsOverdueRegardlessOfRatio() public {
        uint32 loanId = _activeLoan();

        (bool warning, bool liquidatable) = manager.isAtRisk(loanId, 5000);
        assertFalse(warning, "healthy loan should not warn");
        assertFalse(liquidatable, "healthy loan should not be liquidatable");

        vm.warp(block.timestamp + DURATION + 1);
        (warning, liquidatable) = manager.isAtRisk(loanId, 5000);
        assertTrue(liquidatable, "overdue loan should be liquidatable");
        assertFalse(warning, "liquidatable loan should not also warn");
    }

    function test_IsAtRiskWarnsBetweenMinAndWarning() public {
        uint32 loanId = _activeLoan();

        (bool warning, bool liquidatable) = manager.isAtRisk(loanId, 3700);
        assertTrue(warning, "3700 sits between min 3500 and warning 4000");
        assertFalse(liquidatable, "3700 is above the minimum stake");

        (warning, liquidatable) = manager.isAtRisk(loanId, 3400);
        assertFalse(warning, "below min is liquidatable, not a warning");
        assertTrue(liquidatable, "3400 is below the 3500 minimum stake");
    }
}
