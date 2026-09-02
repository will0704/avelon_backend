// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AvelonLiquidityPool
 * @dev ETH lending pool with per-investor share accounting.
 *
 * Investors deposit ETH and receive shares. The pool's total assets are the ETH it
 * still holds plus the principal currently lent out. Interest arriving from
 * repayments is not distributed per investor — it raises the assets backing every
 * share, so yield accrues pro rata and two investors cannot affect each other's
 * balance. A default written off lowers the same number, so losses are shared the
 * same way.
 *
 * CAPSTONE SCOPE. This contract is deliberately simple and is not audited:
 *
 * - The owner (the Avelon backend signer) decides which loans get funded. It cannot
 *   take investor funds — fundLoan is the only path ETH leaves by, and only to the
 *   borrower named for that loan — but it is trusted to write off bad debt honestly.
 *   Repayment does not trust anyone: borrowers call repay() themselves and the
 *   contract computes the principal/interest split. A production pool would read
 *   loan state from AvelonLending instead of keeping its own copy.
 * - Withdrawals are first-come-first-served against idle cash. There is no
 *   redemption queue: an investor whose share exceeds idle cash must wait for
 *   repayments. maxWithdrawableAssets() reports what is actually available.
 * - No interest accrual on outstanding principal. A loan contributes yield only
 *   when it is repaid, so share price steps rather than drifts.
 * - No upgrade path, no emergency exit for investors, no fee switch.
 */
contract AvelonLiquidityPool is Ownable, Pausable, ReentrancyGuard {
    // ============================================
    // CUSTOM ERRORS
    // ============================================

    error MustSendETH();
    error InvalidAddress();
    error InvalidAmount();
    error NoShares();
    error InsufficientShares();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error LoanAlreadyFunded();
    error LoanNotFunded();
    error PrincipalExceedsOutstanding();
    error NoYieldToClaim();
    error TransferFailed();

    // ============================================
    // STATE
    // ============================================

    /// @dev Shares held per investor.
    mapping(address => uint256) public shares;
    uint256 public totalShares;

    /// @dev What each investor put in, in ETH. Used only to separate yield from
    ///      principal for claimYield; it is not what a share is worth.
    mapping(address => uint256) public depositedPrincipal;

    /// @dev Principal still out with borrowers, by AvelonLending loan id.
    mapping(uint32 => uint256) public loanPrincipal;
    uint256 public totalOutstandingPrincipal;

    /// @dev Running totals, for reporting only.
    uint256 public cumulativeInterest;
    uint256 public cumulativeWriteOffs;

    // ============================================
    // EVENTS
    // ============================================

    event Deposited(address indexed investor, uint256 assets, uint256 sharesMinted);
    event Withdrawn(address indexed investor, uint256 assets, uint256 sharesBurned);
    event YieldClaimed(address indexed investor, uint256 assets, uint256 sharesBurned);
    event LoanFunded(uint32 indexed loanId, address indexed borrower, uint256 amount);
    event RepaymentReceived(uint32 indexed loanId, uint256 principal, uint256 interest);
    event LoanWrittenOff(uint32 indexed loanId, uint256 amount);
    event RecoveryReceived(uint32 indexed loanId, uint256 amount);

    constructor() Ownable(msg.sender) {}

    // ============================================
    // ACCOUNTING
    // ============================================

    /**
     * @dev Everything the pool owns: idle ETH plus principal out with borrowers.
     */
    function totalAssets() public view returns (uint256) {
        return address(this).balance + totalOutstandingPrincipal;
    }

    /**
     * @dev ETH available to pay withdrawals right now.
     */
    function availableLiquidity() public view returns (uint256) {
        return address(this).balance;
    }

    /*
     * The +1 offsets below are OpenZeppelin's ERC4626 virtual share/asset trick.
     * Without them the first depositor can mint 1 wei of shares, donate ETH
     * directly to the contract, and make every later deposit round down to zero
     * shares. The offset makes that attack cost more than it yields.
     */

    function convertToShares(uint256 assets, uint256 assetsBefore) internal view returns (uint256) {
        return (assets * (totalShares + 1)) / (assetsBefore + 1);
    }

    function convertToAssets(uint256 shareAmount) public view returns (uint256) {
        return (shareAmount * (totalAssets() + 1)) / (totalShares + 1);
    }

    /**
     * @dev Current ETH value of an investor's position, principal plus accrued yield.
     */
    function assetsOf(address investor) public view returns (uint256) {
        return convertToAssets(shares[investor]);
    }

    /**
     * @dev Yield earned above what the investor deposited. Zero if the pool has
     *      taken losses and the position is under water.
     */
    function yieldOf(address investor) public view returns (uint256) {
        uint256 assets = assetsOf(investor);
        uint256 basis = depositedPrincipal[investor];
        return assets > basis ? assets - basis : 0;
    }

    /**
     * @dev What this investor could actually take out now — their position, capped
     *      by the pool's idle cash.
     */
    function maxWithdrawableAssets(address investor) external view returns (uint256) {
        uint256 assets = assetsOf(investor);
        uint256 cash = address(this).balance;
        return assets < cash ? assets : cash;
    }

    // ============================================
    // INVESTOR ACTIONS
    // ============================================

    /**
     * @dev Deposit ETH and receive shares. The investor signs this themselves; the
     *      pool never holds a key on their behalf.
     */
    function deposit() external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert MustSendETH();

        // balance already includes msg.value, so price the shares off the pool as
        // it stood before this deposit landed.
        uint256 assetsBefore = totalAssets() - msg.value;
        uint256 minted = convertToShares(msg.value, assetsBefore);
        if (minted == 0) revert InvalidAmount();

        shares[msg.sender] += minted;
        totalShares += minted;
        depositedPrincipal[msg.sender] += msg.value;

        emit Deposited(msg.sender, msg.value, minted);
    }

    /**
     * @dev Burn shares and take out the ETH they are worth.
     * @param shareAmount Shares to redeem. Must not exceed the caller's balance.
     */
    function withdraw(uint256 shareAmount) external nonReentrant {
        if (shareAmount == 0) revert InvalidAmount();
        uint256 held = shares[msg.sender];
        if (held == 0) revert NoShares();
        if (shareAmount > held) revert InsufficientShares();

        uint256 assets = convertToAssets(shareAmount);
        uint256 cash = address(this).balance;
        if (assets > cash) revert InsufficientLiquidity(assets, cash);

        // Retire the matching slice of the investor's cost basis, so a partial
        // withdrawal does not leave them looking permanently in profit or loss.
        uint256 basisOut = (depositedPrincipal[msg.sender] * shareAmount) / held;

        shares[msg.sender] = held - shareAmount;
        totalShares -= shareAmount;
        depositedPrincipal[msg.sender] -= basisOut;

        _send(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shareAmount);
    }

    /**
     * @dev Take out only the gain, leaving the deposited principal invested.
     *      Compounding is the default — an investor who never calls this simply
     *      keeps the yield working, since it is already inside their shares.
     */
    function claimYield() external nonReentrant {
        uint256 pending = yieldOf(msg.sender);
        if (pending == 0) revert NoYieldToClaim();

        uint256 cash = address(this).balance;
        if (pending > cash) revert InsufficientLiquidity(pending, cash);

        // Burn the shares that gain is worth; the basis stays where it is.
        uint256 burned = (pending * (totalShares + 1)) / (totalAssets() + 1);
        if (burned == 0) revert NoYieldToClaim();
        if (burned > shares[msg.sender]) burned = shares[msg.sender];

        shares[msg.sender] -= burned;
        totalShares -= burned;

        _send(msg.sender, pending);
        emit YieldClaimed(msg.sender, pending, burned);
    }

    // ============================================
    // LOAN FLOW — owner only
    // ============================================

    /**
     * @dev Pay an approved loan out of pool cash, straight to the borrower.
     * @param loanId AvelonLending loan id. One funding per id.
     */
    function fundLoan(uint32 loanId, address borrower, uint256 amount) external onlyOwner nonReentrant whenNotPaused {
        if (borrower == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (loanPrincipal[loanId] != 0) revert LoanAlreadyFunded();

        uint256 cash = address(this).balance;
        if (amount > cash) revert InsufficientLiquidity(amount, cash);

        loanPrincipal[loanId] = amount;
        totalOutstandingPrincipal += amount;

        _send(borrower, amount);
        emit LoanFunded(loanId, borrower, amount);
    }

    /**
     * @dev Repay a loan. The borrower calls this directly, so repayment funds never
     *      pass through a backend-held wallet.
     *
     *      The split is computed here rather than passed in: a caller who could
     *      declare their own payment "all interest" would leave the principal
     *      outstanding while the cash also landed, counting the same ETH twice and
     *      inflating every share. Principal is retired first and only the excess
     *      counts as yield, so the pool recognises interest late rather than early.
     */
    function repay(uint32 loanId) external payable nonReentrant {
        if (msg.value == 0) revert MustSendETH();

        uint256 outstanding = loanPrincipal[loanId];
        uint256 principalPortion = msg.value < outstanding ? msg.value : outstanding;

        if (principalPortion > 0) {
            loanPrincipal[loanId] = outstanding - principalPortion;
            totalOutstandingPrincipal -= principalPortion;
        }

        uint256 interest = msg.value - principalPortion;
        cumulativeInterest += interest;

        emit RepaymentReceived(loanId, principalPortion, interest);
    }

    /**
     * @dev Write off principal the pool will not get back. No ETH moves; the loss
     *      lands on share value, split pro rata across every investor.
     */
    function writeOffLoan(uint32 loanId, uint256 amount) external onlyOwner {
        if (amount == 0) revert InvalidAmount();
        uint256 outstanding = loanPrincipal[loanId];
        if (outstanding == 0) revert LoanNotFunded();
        if (amount > outstanding) revert PrincipalExceedsOutstanding();

        loanPrincipal[loanId] = outstanding - amount;
        totalOutstandingPrincipal -= amount;
        cumulativeWriteOffs += amount;

        emit LoanWrittenOff(loanId, amount);
    }

    /**
     * @dev Route a seized borrower stake back to the pool that funded the loan.
     *      Counts as recovery, not principal, because the write-off already happened.
     */
    function recordRecovery(uint32 loanId) external payable {
        if (msg.value == 0) revert MustSendETH();
        emit RecoveryReceived(loanId, msg.value);
    }

    // ============================================
    // ADMIN
    // ============================================

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================
    // INTERNAL
    // ============================================

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Plain transfers are treated as a donation to every shareholder. Kept so
    ///      a mis-sent repayment is not stuck, not as a supported path.
    receive() external payable {}
}
