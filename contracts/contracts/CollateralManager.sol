// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAvelonLending {
    function activateLoan(uint32 loanId) external;
    function liquidateLoan(uint32 loanId) external;

    // Gas-efficient targeted getters (avoid full struct reads)
    function getLoanBorrowerAndStatus(uint32 loanId) external view returns (address borrower, uint8 status);
    function getLoanCollateralRequired(uint32 loanId) external view returns (uint128);
    function getLoanOwed(uint32 loanId) external view returns (uint128 principalOwed, uint128 interestOwed);

    function isOverdue(uint32 loanId) external view returns (bool);
    function treasury() external view returns (address);
}

/**
 * @title CollateralManager
 * @dev Manages ETH collateral for loans in the Avelon lending platform
 * Gas-optimized with state packing and custom errors
 */
contract CollateralManager is Ownable, ReentrancyGuard {
    // Why a loan was liquidated. Default is checked on-chain; Shortfall is judged
    // off-chain against a fiat rate and recorded here for the audit trail.
    enum LiquidationReason { Default, Shortfall }

    // ============================================
    // CUSTOM ERRORS
    // ============================================

    error InvalidAddress();
    error MustSendETH();
    error LendingContractNotSet();
    error LoanNotFound();
    error LoanNotPending();
    error LoanNotActive();
    error LoanNotRepaid();
    error OnlyBorrower();
    error InsufficientCollateral();
    error NoCollateralLocked();
    error CollateralRatioHealthy();
    error LoanNotOverdue();
    error PenaltyTooHigh();
    error InsufficientBalance();
    error TransferFailed();
    error MinRatioTooLow();
    error WarningMustExceedMin();

    // ============================================
    // STATE VARIABLES
    // ============================================

    // These two are now the borrower's own stake, not full security for the debt.
    // A loan is deliberately under-secured; the credit score prices the rest.
    // Slot 1: address(20) + uint16(2) + uint16(2) + uint16(2) = 26 bytes — packed!
    IAvelonLending public lendingContract;
    uint16 public minCollateralRatio = 3500;        // 35% in basis points
    uint16 public warningCollateralRatio = 4000;    // 40% in basis points
    uint16 public liquidationPenalty = 500;          // 5% in basis points

    // Loan ID => Collateral deposited (in wei)
    mapping(uint32 => uint128) public collateralDeposits;

    // Loan ID => Is collateral locked
    mapping(uint32 => bool) public isCollateralLocked;

    // ============================================
    // EVENTS
    // ============================================

    event CollateralDeposited(uint32 indexed loanId, address indexed depositor, uint128 amount);
    event CollateralAdded(uint32 indexed loanId, address indexed depositor, uint128 amount);
    event CollateralReleased(uint32 indexed loanId, address indexed recipient, uint128 amount);
    event CollateralLiquidated(
        uint32 indexed loanId,
        uint128 amount,
        uint128 penalty,
        LiquidationReason reason,
        uint16 observedRatioBps
    );
    event LendingContractUpdated(address indexed oldContract, address indexed newContract);
    event CollateralRatiosUpdated(uint16 minRatio, uint16 warningRatio);

    // ============================================
    // CONSTRUCTOR
    // ============================================

    constructor() Ownable(msg.sender) {}

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    /**
     * @dev Set the AvelonLending contract address
     */
    function setLendingContract(address _lendingContract) external onlyOwner {
        if (_lendingContract == address(0)) revert InvalidAddress();
        address oldContract = address(lendingContract);
        lendingContract = IAvelonLending(_lendingContract);
        emit LendingContractUpdated(oldContract, _lendingContract);
    }

    /**
     * @dev Update collateral ratio thresholds
     */
    function setCollateralRatios(
        uint16 _minRatio,
        uint16 _warningRatio
    ) external onlyOwner {
        // 10% floor — catches a fat-fingered zero, still allows a 35% stake
        if (_minRatio < 1000) revert MinRatioTooLow();
        if (_warningRatio <= _minRatio) revert WarningMustExceedMin();
        minCollateralRatio = _minRatio;
        warningCollateralRatio = _warningRatio;
        emit CollateralRatiosUpdated(_minRatio, _warningRatio);
    }

    /**
     * @dev Set liquidation penalty (in basis points)
     */
    function setLiquidationPenalty(uint16 _penalty) external onlyOwner {
        if (_penalty > 2000) revert PenaltyTooHigh(); // Max 20%
        liquidationPenalty = _penalty;
    }

    // ============================================
    // COLLATERAL FUNCTIONS
    // ============================================

    /**
     * @dev Deposit collateral for a loan
     * @param loanId The loan ID to deposit collateral for
     */
    function depositCollateral(uint32 loanId) external payable nonReentrant {
        if (msg.value == 0) revert MustSendETH();
        if (address(lendingContract) == address(0)) revert LendingContractNotSet();

        // Use targeted getter instead of full struct read
        (address borrower, uint8 status) = lendingContract.getLoanBorrowerAndStatus(loanId);
        uint128 collateralRequired = lendingContract.getLoanCollateralRequired(loanId);

        if (borrower == address(0)) revert LoanNotFound();
        if (status != 0) revert LoanNotPending(); // PendingCollateral = 0
        if (msg.sender != borrower) revert OnlyBorrower();
        if (msg.value < collateralRequired) revert InsufficientCollateral();

        collateralDeposits[loanId] = uint128(msg.value);
        isCollateralLocked[loanId] = true;

        emit CollateralDeposited(loanId, msg.sender, uint128(msg.value));

        // Activate the loan in the lending contract
        lendingContract.activateLoan(loanId);
    }

    /**
     * @dev Add more collateral to an existing loan
     * @param loanId The loan ID
     */
    function addCollateral(uint32 loanId) external payable nonReentrant {
        if (msg.value == 0) revert MustSendETH();
        if (!isCollateralLocked[loanId]) revert NoCollateralLocked();

        (address borrower, uint8 status) = lendingContract.getLoanBorrowerAndStatus(loanId);

        if (status != 1) revert LoanNotActive(); // Active = 1
        if (msg.sender != borrower) revert OnlyBorrower();

        collateralDeposits[loanId] += uint128(msg.value);

        emit CollateralAdded(loanId, msg.sender, uint128(msg.value));
    }

    /**
     * @dev Release collateral after loan is repaid
     * @param loanId The loan ID
     */
    function releaseCollateral(uint32 loanId) external nonReentrant onlyOwner {
        if (!isCollateralLocked[loanId]) revert NoCollateralLocked();

        (address borrower, uint8 status) = lendingContract.getLoanBorrowerAndStatus(loanId);

        if (status != 2) revert LoanNotRepaid(); // Repaid = 2

        uint128 amount = collateralDeposits[loanId];
        collateralDeposits[loanId] = 0;
        isCollateralLocked[loanId] = false;

        (bool success, ) = borrower.call{value: amount}("");
        if (!success) revert TransferFailed();

        emit CollateralReleased(loanId, borrower, amount);
    }

    /**
     * @dev Seize the borrower's stake on default or on a collateral value shortfall.
     * @param loanId The loan ID
     * @param reason Default is verified here; Shortfall is asserted by the owner
     * @param observedRatioBps Stake as a share of the debt in fiat terms, basis
     *        points. Only read for Shortfall; pass 0 for Default.
     *
     * The old ratio check could never fire: stake and debt are both denominated in
     * ETH, and the debt only shrinks as the borrower repays, so the ratio only ever
     * climbed away from the threshold. Price risk is only visible in fiat terms, and
     * that needs an off-chain rate.
     */
    function liquidate(
        uint32 loanId,
        LiquidationReason reason,
        uint16 observedRatioBps
    ) external nonReentrant onlyOwner {
        if (!isCollateralLocked[loanId]) revert NoCollateralLocked();

        (, uint8 status) = lendingContract.getLoanBorrowerAndStatus(loanId);
        if (status != 1) revert LoanNotActive(); // Active = 1

        if (reason == LiquidationReason.Default) {
            // Verified on-chain — the backend cannot fake a missed due date
            if (!lendingContract.isOverdue(loanId)) revert LoanNotOverdue();
        } else {
            if (observedRatioBps >= minCollateralRatio) revert CollateralRatioHealthy();
        }

        uint128 collateral = collateralDeposits[loanId];

        // Split is recorded, not transferred: both halves go to the treasury and the
        // pool/platform attribution happens off-chain, same as the interest split.
        uint128 penalty = uint128((uint256(collateral) * liquidationPenalty) / 10000);
        uint128 amountAfterPenalty = collateral - penalty;

        // Clear collateral before any external call
        collateralDeposits[loanId] = 0;
        isCollateralLocked[loanId] = false;

        // Notify lending contract
        lendingContract.liquidateLoan(loanId);

        // Seized stake used to stay stranded in this contract, reachable only through
        // emergencyWithdraw. It belongs to the pool the loan was paid out of.
        address treasuryAddr = lendingContract.treasury();
        if (treasuryAddr == address(0)) revert InvalidAddress();

        (bool success, ) = treasuryAddr.call{value: collateral}("");
        if (!success) revert TransferFailed();

        emit CollateralLiquidated(loanId, amountAfterPenalty, penalty, reason, observedRatioBps);
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /**
     * @dev Get collateral amount for a loan
     */
    function getCollateral(uint32 loanId) external view returns (uint128) {
        return collateralDeposits[loanId];
    }

    /**
     * @dev Calculate current collateral ratio for a loan
     * @return ratio Collateral ratio in basis points (10000 = 100%)
     *
     * ETH stake over ETH debt, so this does not move with the ETH price. Informational
     * only — it is not what liquidation keys off. See liquidate().
     */
    function getCollateralRatio(uint32 loanId) external view returns (uint256 ratio) {
        uint128 collateral = collateralDeposits[loanId];
        if (collateral == 0) return 0;

        (uint128 principalOwed, uint128 interestOwed) = lendingContract.getLoanOwed(loanId);

        uint256 totalOwed = uint256(principalOwed) + interestOwed;
        if (totalOwed == 0) return type(uint256).max;

        return (uint256(collateral) * 10000) / totalOwed;
    }

    /**
     * @dev Check if a loan is at risk of liquidation
     * @param observedRatioBps Stake as a share of the debt in fiat terms, basis points.
     *        Caller supplies it because the on-chain ETH ratio carries no price signal.
     */
    function isAtRisk(
        uint32 loanId,
        uint16 observedRatioBps
    ) external view returns (bool warning, bool liquidatable) {
        if (!isCollateralLocked[loanId]) return (false, false);

        liquidatable = lendingContract.isOverdue(loanId) || observedRatioBps < minCollateralRatio;
        warning = !liquidatable && observedRatioBps < warningCollateralRatio;
    }

    /**
     * @dev Get contract ETH balance
     */
    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // ============================================
    // EMERGENCY FUNCTIONS
    // ============================================

    /**
     * @dev Emergency withdrawal - only for stuck funds
     */
    function emergencyWithdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        if (amount > address(this).balance) revert InsufficientBalance();

        (bool success, ) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    /**
     * @dev Receive ETH
     */
    receive() external payable {}
}
