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
}

/**
 * @title CollateralManager
 * @dev Manages ETH collateral for loans in the Avelon lending platform
 * Gas-optimized with state packing and custom errors
 */
contract CollateralManager is Ownable, ReentrancyGuard {
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
    error PenaltyTooHigh();
    error InsufficientBalance();
    error TransferFailed();
    error MinRatioTooLow();
    error WarningMustExceedMin();

    // ============================================
    // STATE VARIABLES
    // ============================================

    // Slot 1: address(20) + uint16(2) + uint16(2) + uint16(2) = 26 bytes — packed!
    IAvelonLending public lendingContract;
    uint16 public minCollateralRatio = 12000;       // 120% in basis points
    uint16 public warningCollateralRatio = 13000;   // 130% in basis points
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
    event CollateralLiquidated(uint32 indexed loanId, uint128 amount, uint128 penalty);
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
        if (_minRatio < 10000) revert MinRatioTooLow();
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
     * @dev Liquidate collateral for an undercollateralized or overdue loan
     * @param loanId The loan ID
     */
    function liquidate(uint32 loanId) external nonReentrant onlyOwner {
        if (!isCollateralLocked[loanId]) revert NoCollateralLocked();

        (uint128 principalOwed, uint128 interestOwed) = lendingContract.getLoanOwed(loanId);
        (, uint8 status) = lendingContract.getLoanBorrowerAndStatus(loanId);

        if (status != 1) revert LoanNotActive(); // Active = 1

        uint128 collateral = collateralDeposits[loanId];
        uint256 totalOwed = uint256(principalOwed) + interestOwed;

        // Calculate collateral ratio
        uint256 currentRatio = (uint256(collateral) * 10000) / totalOwed;
        if (currentRatio >= minCollateralRatio) revert CollateralRatioHealthy();

        // Calculate penalty
        uint128 penalty = uint128((uint256(collateral) * liquidationPenalty) / 10000);
        uint128 amountAfterPenalty = collateral - penalty;

        // Clear collateral
        collateralDeposits[loanId] = 0;
        isCollateralLocked[loanId] = false;

        // Notify lending contract
        lendingContract.liquidateLoan(loanId);

        emit CollateralLiquidated(loanId, amountAfterPenalty, penalty);
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
     */
    function isAtRisk(uint32 loanId) external view returns (bool warning, bool liquidatable) {
        uint256 ratio = this.getCollateralRatio(loanId);
        warning = ratio < warningCollateralRatio && ratio >= minCollateralRatio;
        liquidatable = ratio < minCollateralRatio;
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
