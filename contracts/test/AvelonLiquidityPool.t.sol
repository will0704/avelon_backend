// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./lib/Harness.sol";
import "../contracts/AvelonLiquidityPool.sol";

/**
 * Covers the share accounting the investor role depends on: yield and losses land
 * pro rata, one investor's activity cannot move another's balance, and nothing can
 * take ETH out of the pool except the investor who owns the shares or a funded loan.
 */
contract AvelonLiquidityPoolTest is Harness {
    AvelonLiquidityPool internal pool;

    address internal constant ALICE = 0x4444444444444444444444444444444444444444;
    address internal constant BOB = 0x5555555555555555555555555555555555555555;
    address internal constant BORROWER = 0x2222222222222222222222222222222222222222;
    address internal constant OUTSIDER = 0x3333333333333333333333333333333333333333;

    uint32 internal constant LOAN_ID = 7;

    function setUp() public {
        // This contract owns the pool, standing in for the backend signer
        pool = new AvelonLiquidityPool();
        vm.deal(ALICE, 1000 ether);
        vm.deal(BOB, 1000 ether);
        // borrowers repay more than they drew, so they need their own funds
        vm.deal(BORROWER, 1000 ether);
        vm.deal(address(this), 1000 ether);
    }

    /// @dev The +1 virtual offsets cost a wei or two of precision. Anything larger
    ///      than a rounding error is a real accounting bug.
    function assertNear(uint256 actual, uint256 expected, string memory what) internal pure {
        uint256 diff = actual > expected ? actual - expected : expected - actual;
        if (diff > 10) revert AssertionFailedUint(what, expected, actual);
    }

    function _deposit(address who, uint256 amount) internal {
        vm.prank(who);
        pool.deposit{value: amount}();
    }

    // ── deposits ─────────────────────────────────────────────────────────

    function test_FirstDepositMintsSharesOneForOne() public {
        _deposit(ALICE, 10 ether);

        assertEq(pool.totalShares(), 10 ether, "shares minted");
        assertEq(pool.totalAssets(), 10 ether, "pool assets");
        assertNear(pool.assetsOf(ALICE), 10 ether, "alice position");
        assertEq(pool.depositedPrincipal(ALICE), 10 ether, "alice basis");
        assertEq(pool.yieldOf(ALICE), 0, "no yield yet");
    }

    function test_SecondDepositorGetsProportionalShares() public {
        _deposit(ALICE, 10 ether);
        _deposit(BOB, 30 ether);

        assertNear(pool.assetsOf(ALICE), 10 ether, "alice position");
        assertNear(pool.assetsOf(BOB), 30 ether, "bob position");
        assertEq(pool.totalAssets(), 40 ether, "pool assets");
    }

    function test_ZeroDepositReverts() public {
        vm.prank(ALICE);
        vm.expectRevert(AvelonLiquidityPool.MustSendETH.selector);
        pool.deposit{value: 0}();
    }

    function test_DepositRejectedWhilePaused() public {
        pool.pause();
        vm.prank(ALICE);
        vm.expectRevert(bytes4(keccak256("EnforcedPause()")));
        pool.deposit{value: 1 ether}();
    }

    // ── funding a loan ───────────────────────────────────────────────────

    function test_FundLoanMovesCashAndTracksPrincipal() public {
        _deposit(ALICE, 10 ether);
        pool.fundLoan(LOAN_ID, BORROWER, 6 ether);

        assertEq(BORROWER.balance, 1006 ether, "borrower funded");
        assertEq(pool.availableLiquidity(), 4 ether, "idle cash");
        assertEq(pool.totalOutstandingPrincipal(), 6 ether, "outstanding");
        // Lending it out does not change what the pool is worth
        assertEq(pool.totalAssets(), 10 ether, "assets unchanged by lending");
        assertNear(pool.assetsOf(ALICE), 10 ether, "alice position unchanged");
    }

    function test_FundLoanRejectsSecondFundingOfSameLoan() public {
        _deposit(ALICE, 10 ether);
        pool.fundLoan(LOAN_ID, BORROWER, 1 ether);

        vm.expectRevert(AvelonLiquidityPool.LoanAlreadyFunded.selector);
        pool.fundLoan(LOAN_ID, BORROWER, 1 ether);
    }

    function test_FundLoanRejectsMoreThanCash() public {
        _deposit(ALICE, 5 ether);
        vm.expectRevert(
            abi.encodeWithSelector(AvelonLiquidityPool.InsufficientLiquidity.selector, 6 ether, 5 ether)
        );
        pool.fundLoan(LOAN_ID, BORROWER, 6 ether);
    }

    function test_OnlyOwnerCanFundLoan() public {
        _deposit(ALICE, 10 ether);
        vm.prank(OUTSIDER);
        vm.expectRevert(
            abi.encodeWithSelector(bytes4(keccak256("OwnableUnauthorizedAccount(address)")), OUTSIDER)
        );
        pool.fundLoan(LOAN_ID, OUTSIDER, 1 ether);
    }

    // ── yield ────────────────────────────────────────────────────────────

    function test_InterestSplitsProRataAndInvestorsStayIsolated() public {
        _deposit(ALICE, 10 ether);
        _deposit(BOB, 30 ether);

        pool.fundLoan(LOAN_ID, BORROWER, 20 ether);
        vm.prank(BORROWER);
        pool.repay{value: 24 ether}(LOAN_ID);

        // 4 ETH of interest on a 1:3 ownership split
        assertNear(pool.assetsOf(ALICE), 11 ether, "alice after yield");
        assertNear(pool.assetsOf(BOB), 33 ether, "bob after yield");
        assertNear(pool.yieldOf(ALICE), 1 ether, "alice yield");
        assertNear(pool.yieldOf(BOB), 3 ether, "bob yield");
        assertEq(pool.cumulativeInterest(), 4 ether, "interest recorded");
        assertEq(pool.totalOutstandingPrincipal(), 0, "principal retired");
    }

    function test_DepositAfterYieldDoesNotDiluteEarlierInvestor() public {
        _deposit(ALICE, 10 ether);
        pool.fundLoan(LOAN_ID, BORROWER, 5 ether);
        vm.prank(BORROWER);
        pool.repay{value: 6 ether}(LOAN_ID);
        // Alice is now worth 11 ETH on 10 shares

        _deposit(BOB, 11 ether);

        assertNear(pool.assetsOf(ALICE), 11 ether, "alice keeps her gain");
        assertNear(pool.assetsOf(BOB), 11 ether, "bob buys in at the new price");
        assertEq(pool.yieldOf(BOB), 0, "bob has earned nothing yet");
    }

    function test_ClaimYieldPaysGainAndLeavesPrincipalInvested() public {
        _deposit(ALICE, 10 ether);
        _deposit(BOB, 30 ether);
        pool.fundLoan(LOAN_ID, BORROWER, 20 ether);
        vm.prank(BORROWER);
        pool.repay{value: 24 ether}(LOAN_ID);

        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.claimYield();

        assertNear(ALICE.balance - before, 1 ether, "yield paid out");
        assertNear(pool.assetsOf(ALICE), 10 ether, "principal still invested");
        assertEq(pool.depositedPrincipal(ALICE), 10 ether, "basis untouched");
        assertEq(pool.yieldOf(ALICE), 0, "nothing left to claim");
        // Bob is unaffected by Alice claiming
        assertNear(pool.assetsOf(BOB), 33 ether, "bob unaffected");
    }

    function test_ClaimYieldRevertsWithNothingEarned() public {
        _deposit(ALICE, 10 ether);
        vm.prank(ALICE);
        vm.expectRevert(AvelonLiquidityPool.NoYieldToClaim.selector);
        pool.claimYield();
    }

    // ── withdrawals ──────────────────────────────────────────────────────

    function test_WithdrawReturnsPrincipalPlusYield() public {
        _deposit(ALICE, 10 ether);
        _deposit(BOB, 30 ether);
        pool.fundLoan(LOAN_ID, BORROWER, 20 ether);
        vm.prank(BORROWER);
        pool.repay{value: 24 ether}(LOAN_ID);

        uint256 before = ALICE.balance;
        uint256 aliceShares = pool.shares(ALICE);
        vm.prank(ALICE);
        pool.withdraw(aliceShares);

        assertNear(ALICE.balance - before, 11 ether, "full position paid out");
        assertEq(pool.shares(ALICE), 0, "shares burned");
        assertEq(pool.depositedPrincipal(ALICE), 0, "basis cleared");
        assertNear(pool.assetsOf(BOB), 33 ether, "bob unaffected by alice exiting");
    }

    function test_PartialWithdrawRetiresProportionalBasis() public {
        _deposit(ALICE, 10 ether);
        uint256 half = pool.shares(ALICE) / 2;
        vm.prank(ALICE);
        pool.withdraw(half);

        assertNear(pool.assetsOf(ALICE), 5 ether, "half the position remains");
        assertNear(pool.depositedPrincipal(ALICE), 5 ether, "half the basis remains");
    }

    function test_WithdrawMoreSharesThanHeldReverts() public {
        _deposit(ALICE, 10 ether);
        _deposit(BOB, 10 ether);

        uint256 tooMany = pool.shares(ALICE) + 1;
        vm.prank(ALICE);
        vm.expectRevert(AvelonLiquidityPool.InsufficientShares.selector);
        pool.withdraw(tooMany);
    }

    function test_WithdrawWithNoSharesReverts() public {
        _deposit(ALICE, 10 ether);
        vm.prank(OUTSIDER);
        vm.expectRevert(AvelonLiquidityPool.NoShares.selector);
        pool.withdraw(1);
    }

    function test_WithdrawBlockedWhenLiquidityIsLentOut() public {
        _deposit(ALICE, 10 ether);
        pool.fundLoan(LOAN_ID, BORROWER, 8 ether);

        // Alice still owns 10 ETH of pool, but only 2 ETH is idle
        uint256 aliceShares = pool.shares(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(AvelonLiquidityPool.InsufficientLiquidity.selector, 10 ether, 2 ether)
        );
        pool.withdraw(aliceShares);

        assertEq(pool.maxWithdrawableAssets(ALICE), 2 ether, "reported headroom");
    }

    // ── losses ───────────────────────────────────────────────────────────

    function test_WriteOffIsSharedProRata() public {
        _deposit(ALICE, 10 ether);
        _deposit(BOB, 30 ether);
        pool.fundLoan(LOAN_ID, BORROWER, 20 ether);

        pool.writeOffLoan(LOAN_ID, 4 ether);

        assertEq(pool.totalAssets(), 36 ether, "assets written down");
        assertNear(pool.assetsOf(ALICE), 9 ether, "alice takes a quarter of the loss");
        assertNear(pool.assetsOf(BOB), 27 ether, "bob takes three quarters");
        assertEq(pool.yieldOf(ALICE), 0, "under water reports zero yield");
        assertEq(pool.cumulativeWriteOffs(), 4 ether, "write-off recorded");
    }

    function test_OnlyOwnerCanWriteOff() public {
        _deposit(ALICE, 10 ether);
        pool.fundLoan(LOAN_ID, BORROWER, 5 ether);

        vm.prank(OUTSIDER);
        vm.expectRevert(
            abi.encodeWithSelector(bytes4(keccak256("OwnableUnauthorizedAccount(address)")), OUTSIDER)
        );
        pool.writeOffLoan(LOAN_ID, 1 ether);
    }

    function test_RecoveryOnSeizedStakeLiftsShareValue() public {
        _deposit(ALICE, 10 ether);
        pool.fundLoan(LOAN_ID, BORROWER, 5 ether);
        pool.writeOffLoan(LOAN_ID, 5 ether);
        assertNear(pool.assetsOf(ALICE), 5 ether, "loss taken");

        pool.recordRecovery{value: 1.75 ether}(LOAN_ID);
        assertNear(pool.assetsOf(ALICE), 6.75 ether, "stake recovered into the pool");
    }

    // ── repayment guards ─────────────────────────────────────────────────

    function test_OverpaymentRetiresPrincipalThenCountsAsInterest() public {
        _deposit(ALICE, 10 ether);
        pool.fundLoan(LOAN_ID, BORROWER, 5 ether);

        vm.prank(BORROWER);
        pool.repay{value: 6 ether}(LOAN_ID);

        assertEq(pool.loanPrincipal(LOAN_ID), 0, "principal retired");
        assertEq(pool.cumulativeInterest(), 1 ether, "excess is yield");
        assertNear(pool.assetsOf(ALICE), 11 ether, "yield reaches the investor");
    }

    function test_PartialRepaymentRetiresPrincipalFirstAndEarnsNoYieldYet() public {
        _deposit(ALICE, 10 ether);
        pool.fundLoan(LOAN_ID, BORROWER, 5 ether);

        vm.prank(BORROWER);
        pool.repay{value: 2 ether}(LOAN_ID);

        assertEq(pool.loanPrincipal(LOAN_ID), 3 ether, "principal partly retired");
        assertEq(pool.cumulativeInterest(), 0, "nothing booked as yield yet");
        assertNear(pool.assetsOf(ALICE), 10 ether, "position unchanged");
    }

    function test_PaymentAgainstUnfundedLoanIsAllYield() public {
        _deposit(ALICE, 10 ether);
        // Nothing outstanding on loan 99, so the whole payment is yield
        pool.repay{value: 1 ether}(99);
        assertNear(pool.assetsOf(ALICE), 11 ether, "interest credited");
    }

    // ── full lifecycle ───────────────────────────────────────────────────

    function test_FullLifecycleLeavesPoolEmpty() public {
        _deposit(ALICE, 10 ether);
        _deposit(BOB, 30 ether);
        pool.fundLoan(LOAN_ID, BORROWER, 20 ether);
        vm.prank(BORROWER);
        pool.repay{value: 24 ether}(LOAN_ID);

        uint256 aliceShares = pool.shares(ALICE);
        uint256 bobShares = pool.shares(BOB);
        vm.prank(ALICE);
        pool.withdraw(aliceShares);
        vm.prank(BOB);
        pool.withdraw(bobShares);

        assertEq(pool.totalShares(), 0, "all shares burned");
        assertTrue(pool.availableLiquidity() < 100, "pool drained to dust");
    }
}
