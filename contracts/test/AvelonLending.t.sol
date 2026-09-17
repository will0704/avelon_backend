// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./lib/Harness.sol";
import "../contracts/AvelonLending.sol";
import "../contracts/CollateralManager.sol";

/**
 * The lending contract is the on-chain ledger the backend keeps in step with the
 * database. These cover the amounts and dates both sides must agree on.
 */
contract AvelonLendingTest is Harness {
    AvelonLending internal lending;
    CollateralManager internal manager;

    address internal constant TREASURY = 0x1111111111111111111111111111111111111111;
    address internal constant BORROWER = 0x2222222222222222222222222222222222222222;
    address internal constant STRANGER = 0x3333333333333333333333333333333333333333;

    uint128 internal constant PRINCIPAL = 0.05 ether;
    uint128 internal constant STAKE = 0.03 ether;
    uint16 internal constant RATE_BPS = 800;       // 8%, the Starter plan
    uint32 internal constant DURATION = 30 days;

    function setUp() public {
        lending = new AvelonLending(TREASURY);
        manager = new CollateralManager();
        lending.setCollateralManager(address(manager));
        manager.setLendingContract(address(lending));
        vm.deal(BORROWER, 10 ether);
    }

    function _pending() internal returns (uint32) {
        return lending.createLoan(BORROWER, PRINCIPAL, STAKE, RATE_BPS, DURATION);
    }

    function _active() internal returns (uint32 loanId) {
        loanId = _pending();
        vm.prank(BORROWER);
        manager.depositCollateral{value: STAKE}(loanId);
    }

    // ── interest ─────────────────────────────────────────────────────────

    function test_InterestMatchesTheBackendFormula() public {
        uint32 loanId = _active();
        // 0.05 × 8% × 30/365, rounded down to wei — the same figure the backend stores
        assertEq(lending.getTotalOwed(loanId), 50328767123287671, "total owed");
    }

    // ── repayment bounds ─────────────────────────────────────────────────

    function test_RepaymentAboveOwedReverts() public {
        uint32 loanId = _active();
        uint128 owed = lending.getTotalOwed(loanId);
        vm.expectRevert(AvelonLending.AmountExceedsOwed.selector);
        lending.recordRepayment(loanId, owed + 1);
    }

    function test_ExactRepaymentClosesTheLoan() public {
        uint32 loanId = _active();
        lending.recordRepayment(loanId, lending.getTotalOwed(loanId));
        (, uint8 status) = _status(loanId);
        assertEq(status, 2, "repaid");
    }

    function test_OnlyOwnerRecordsRepayments() public {
        uint32 loanId = _active();
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", STRANGER));
        lending.recordRepayment(loanId, 1);
    }

    // ── cancellation ─────────────────────────────────────────────────────

    function test_CancelledLoanRefusesCollateral() public {
        uint32 loanId = _pending();
        lending.cancelLoan(loanId);
        vm.prank(BORROWER);
        vm.expectRevert(CollateralManager.LoanNotPending.selector);
        manager.depositCollateral{value: STAKE}(loanId);
    }

    function test_ActiveLoanCannotBeCancelled() public {
        uint32 loanId = _active();
        vm.expectRevert(AvelonLending.InvalidLoanStatus.selector);
        lending.cancelLoan(loanId);
    }

    function test_StrangerCannotCancel() public {
        uint32 loanId = _pending();
        vm.prank(STRANGER);
        vm.expectRevert(AvelonLending.NotAuthorized.selector);
        lending.cancelLoan(loanId);
    }

    // ── extension ────────────────────────────────────────────────────────

    function test_ExtensionAddsFeeAndMovesDueDate() public {
        uint32 loanId = _active();
        uint128 owedBefore = lending.getTotalOwed(loanId);
        AvelonLending.Loan memory before = lending.getLoan(loanId);

        lending.extendLoan(loanId, 30 days, 0.0005 ether);

        AvelonLending.Loan memory afterExt = lending.getLoan(loanId);
        assertEq(lending.getTotalOwed(loanId), owedBefore + 0.0005 ether, "fee owed");
        assertEq(afterExt.dueDate, before.dueDate + 30 days, "due date");
    }

    function test_ExtendedLoanIsNotOverdueAtTheOriginalDate() public {
        uint32 loanId = _active();
        AvelonLending.Loan memory loan = lending.getLoan(loanId);
        lending.extendLoan(loanId, 30 days, 0);

        vm.warp(uint256(loan.dueDate) + 1);
        assertFalse(lending.isOverdue(loanId), "not overdue before the new date");

        vm.warp(uint256(loan.dueDate) + 30 days + 1);
        assertTrue(lending.isOverdue(loanId), "overdue after the new date");
    }

    function test_FullPaymentAfterExtensionClosesTheLoan() public {
        uint32 loanId = _active();
        lending.extendLoan(loanId, 30 days, 0.0005 ether);
        lending.recordRepayment(loanId, lending.getTotalOwed(loanId));
        (, uint8 status) = _status(loanId);
        assertEq(status, 2, "repaid");
    }

    function test_ExtensionNeedsAnActiveLoan() public {
        uint32 loanId = _pending();
        vm.expectRevert(AvelonLending.InvalidLoanStatus.selector);
        lending.extendLoan(loanId, 30 days, 0);
    }

    function test_ExtensionNeedsTime() public {
        uint32 loanId = _active();
        vm.expectRevert(AvelonLending.InvalidDuration.selector);
        lending.extendLoan(loanId, 0, 0);
    }

    function test_OnlyOwnerExtends() public {
        uint32 loanId = _active();
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", STRANGER));
        lending.extendLoan(loanId, 30 days, 0);
    }

    function _status(uint32 loanId) internal view returns (address, uint8) {
        (address borrower, AvelonLending.LoanStatus status) = lending.getLoanBorrowerAndStatus(loanId);
        return (borrower, uint8(status));
    }
}
