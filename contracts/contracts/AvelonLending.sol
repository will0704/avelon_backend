// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AvelonLending
 * @dev Core lending contract for the Avelon crypto lending platform
 * Gas-optimized with struct packing and custom errors
 */
contract AvelonLending is Ownable, ReentrancyGuard {
    // ============================================
    // CUSTOM ERRORS
    // ============================================

    error InvalidAddress();
    error InvalidAmount();
    error InvalidDuration();
    error LoanNotFound();
    error InvalidLoanStatus();
    error OnlyCollateralManager();
    error NotAuthorized();
    error AmountExceedsOwed();

    // ============================================
    // TYPES
    // ============================================

    enum LoanStatus {
        PendingCollateral,  // Loan created, awaiting collateral
        Active,             // Collateral deposited, loan disbursed
        Repaid,             // Fully repaid
        Liquidated,         // Collateral liquidated
        Cancelled           // Cancelled before collateral deposit
    }

    /// @dev Packed into 4 storage slots (down from 12)
    struct Loan {
        // Slot 1: address(20) + uint48(6) + uint48(6) = 32 bytes
        address borrower;
        uint48 createdAt;
        uint48 activatedAt;
        // Slot 2: uint48(6) + uint32(4) + uint16(2) + uint8(1) = 13 bytes
        uint48 dueDate;
        uint32 duration;            // Max ~136 years in seconds
        uint16 interestRate;        // Max 655.35% in basis points
        LoanStatus status;
        // Slot 3: uint128(16) + uint128(16) = 32 bytes
        uint128 principal;          // Max ~340 billion ETH in wei
        uint128 collateralRequired;
        // Slot 4: uint128(16) + uint128(16) = 32 bytes
        uint128 principalOwed;
        uint128 interestOwed;
    }

    // ============================================
    // STATE VARIABLES
    // ============================================

    uint32 private _loanIdCounter;
    address public collateralManager;
    address public treasury;

    // Loan ID => Loan
    mapping(uint32 => Loan) public loans;

    // Borrower => Loan IDs
    mapping(address => uint32[]) public borrowerLoans;

    // ============================================
    // EVENTS
    // ============================================

    event LoanCreated(
        uint32 indexed loanId,
        address indexed borrower,
        uint128 principal,
        uint128 collateralRequired,
        uint16 interestRate,
        uint32 duration
    );

    event LoanActivated(uint32 indexed loanId, uint48 activatedAt, uint48 dueDate);
    event RepaymentRecorded(uint32 indexed loanId, uint128 amount, uint128 remainingOwed);
    event LoanRepaid(uint32 indexed loanId, uint48 repaidAt);
    event LoanLiquidated(uint32 indexed loanId, uint48 liquidatedAt);
    event LoanCancelled(uint32 indexed loanId);
    event CollateralManagerUpdated(address indexed oldManager, address indexed newManager);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    // ============================================
    // MODIFIERS
    // ============================================

    modifier onlyCollateralManager() {
        if (msg.sender != collateralManager) revert OnlyCollateralManager();
        _;
    }

    modifier loanExists(uint32 loanId) {
        if (loans[loanId].borrower == address(0) || loanId == 0) revert LoanNotFound();
        _;
    }

    // ============================================
    // CONSTRUCTOR
    // ============================================

    constructor(address _treasury) Ownable(msg.sender) {
        if (_treasury == address(0)) revert InvalidAddress();
        treasury = _treasury;
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    /**
     * @dev Set the CollateralManager contract address
     */
    function setCollateralManager(address _collateralManager) external onlyOwner {
        if (_collateralManager == address(0)) revert InvalidAddress();
        address oldManager = collateralManager;
        collateralManager = _collateralManager;
        emit CollateralManagerUpdated(oldManager, _collateralManager);
    }

    /**
     * @dev Update the treasury address
     */
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert InvalidAddress();
        address oldTreasury = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    // ============================================
    // LOAN LIFECYCLE FUNCTIONS
    // ============================================

    /**
     * @dev Create a new loan application
     * @param borrower Address of the borrower
     * @param principal Loan amount in wei
     * @param collateralRequired Required collateral amount in wei
     * @param interestRate Interest rate in basis points (100 = 1%)
     * @param duration Loan duration in seconds
     */
    function createLoan(
        address borrower,
        uint128 principal,
        uint128 collateralRequired,
        uint16 interestRate,
        uint32 duration
    ) external onlyOwner returns (uint32) {
        if (borrower == address(0)) revert InvalidAddress();
        if (principal == 0) revert InvalidAmount();
        if (collateralRequired == 0) revert InvalidAmount();
        if (duration == 0) revert InvalidDuration();

        _loanIdCounter++;
        uint32 loanId = _loanIdCounter;

        Loan storage loan = loans[loanId];
        loan.borrower = borrower;
        loan.principal = principal;
        loan.collateralRequired = collateralRequired;
        loan.interestRate = interestRate;
        loan.duration = duration;
        loan.createdAt = uint48(block.timestamp);
        loan.principalOwed = principal;
        loan.status = LoanStatus.PendingCollateral;

        borrowerLoans[borrower].push(loanId);

        emit LoanCreated(loanId, borrower, principal, collateralRequired, interestRate, duration);

        return loanId;
    }

    /**
     * @dev Activate a loan after collateral is verified
     * Called by CollateralManager after collateral deposit
     */
    function activateLoan(uint32 loanId) external onlyCollateralManager loanExists(loanId) {
        Loan storage loan = loans[loanId];
        if (loan.status != LoanStatus.PendingCollateral) revert InvalidLoanStatus();

        loan.status = LoanStatus.Active;
        loan.activatedAt = uint48(block.timestamp);
        loan.dueDate = uint48(block.timestamp + loan.duration);

        // Calculate interest owed (simple interest)
        loan.interestOwed = uint128(
            (uint256(loan.principal) * loan.interestRate * loan.duration) / (365 days * 10000)
        );

        emit LoanActivated(loanId, loan.activatedAt, loan.dueDate);
    }

    /**
     * @dev Record a repayment on the loan
     * @param loanId The loan ID
     * @param amount Amount repaid in wei
     */
    function recordRepayment(
        uint32 loanId,
        uint128 amount
    ) external onlyOwner loanExists(loanId) {
        Loan storage loan = loans[loanId];
        if (loan.status != LoanStatus.Active) revert InvalidLoanStatus();
        if (amount == 0) revert InvalidAmount();

        uint128 totalOwed = loan.principalOwed + loan.interestOwed;
        if (amount > totalOwed) revert AmountExceedsOwed();

        // Apply payment to interest first, then principal
        if (amount <= loan.interestOwed) {
            loan.interestOwed -= amount;
        } else {
            uint128 remainingAfterInterest = amount - loan.interestOwed;
            loan.interestOwed = 0;
            loan.principalOwed -= remainingAfterInterest;
        }

        uint128 remainingOwed = loan.principalOwed + loan.interestOwed;
        emit RepaymentRecorded(loanId, amount, remainingOwed);

        // Check if loan is fully repaid
        if (remainingOwed == 0) {
            loan.status = LoanStatus.Repaid;
            emit LoanRepaid(loanId, uint48(block.timestamp));
        }
    }

    /**
     * @dev Mark a loan as liquidated
     */
    function liquidateLoan(uint32 loanId) external onlyCollateralManager loanExists(loanId) {
        Loan storage loan = loans[loanId];
        if (loan.status != LoanStatus.Active) revert InvalidLoanStatus();

        loan.status = LoanStatus.Liquidated;
        emit LoanLiquidated(loanId, uint48(block.timestamp));
    }

    /**
     * @dev Cancel a loan before collateral is deposited
     */
    function cancelLoan(uint32 loanId) external loanExists(loanId) {
        Loan storage loan = loans[loanId];
        if (msg.sender != loan.borrower && msg.sender != owner()) revert NotAuthorized();
        if (loan.status != LoanStatus.PendingCollateral) revert InvalidLoanStatus();

        loan.status = LoanStatus.Cancelled;
        emit LoanCancelled(loanId);
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /**
     * @dev Get loan details
     */
    function getLoan(uint32 loanId) external view returns (Loan memory) {
        return loans[loanId];
    }

    /**
     * @dev Get total amount owed on a loan
     */
    function getTotalOwed(uint32 loanId) external view loanExists(loanId) returns (uint128) {
        Loan storage loan = loans[loanId];
        return loan.principalOwed + loan.interestOwed;
    }

    /**
     * @dev Get all loan IDs for a borrower
     */
    function getBorrowerLoans(address borrower) external view returns (uint32[] memory) {
        return borrowerLoans[borrower];
    }

    /**
     * @dev Check if a loan is overdue
     */
    function isOverdue(uint32 loanId) external view loanExists(loanId) returns (bool) {
        Loan storage loan = loans[loanId];
        return loan.status == LoanStatus.Active && block.timestamp > loan.dueDate;
    }

    /**
     * @dev Get the current loan ID counter
     */
    function getCurrentLoanId() external view returns (uint32) {
        return _loanIdCounter;
    }

    /**
     * @dev Get borrower address and status for a loan (gas-efficient getter for CollateralManager)
     */
    function getLoanBorrowerAndStatus(uint32 loanId) external view returns (address borrower, LoanStatus status) {
        Loan storage loan = loans[loanId];
        return (loan.borrower, loan.status);
    }

    /**
     * @dev Get collateral required for a loan (gas-efficient getter for CollateralManager)
     */
    function getLoanCollateralRequired(uint32 loanId) external view returns (uint128) {
        return loans[loanId].collateralRequired;
    }

    /**
     * @dev Get owed amounts for a loan (gas-efficient getter for CollateralManager)
     */
    function getLoanOwed(uint32 loanId) external view returns (uint128 principalOwed, uint128 interestOwed) {
        Loan storage loan = loans[loanId];
        return (loan.principalOwed, loan.interestOwed);
    }
}
