// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AvelonLending
 * @dev Core lending contract for the Avelon crypto lending platform
 * Manages loan lifecycle: creation, activation, repayment tracking, and closure
 */
contract AvelonLending is Ownable, ReentrancyGuard {
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

    struct Loan {
        uint256 id;
        address borrower;
        uint256 principal;          // Loan amount in wei
        uint256 collateralRequired; // Required collateral in wei
        uint256 interestRate;       // Interest rate in basis points (100 = 1%)
        uint256 duration;           // Duration in seconds
        uint256 createdAt;
        uint256 activatedAt;
        uint256 dueDate;
        uint256 principalOwed;
        uint256 interestOwed;
        LoanStatus status;
    }

    // ============================================
    // STATE VARIABLES
    // ============================================
    
    uint256 private _loanIdCounter;
    address public collateralManager;
    address public treasury;
    
    // Loan ID => Loan
    mapping(uint256 => Loan) public loans;
    
    // Borrower => Loan IDs
    mapping(address => uint256[]) public borrowerLoans;
    
    // ============================================
    // EVENTS
    // ============================================
    
    event LoanCreated(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 principal,
        uint256 collateralRequired,
        uint256 interestRate,
        uint256 duration
    );
    
    event LoanActivated(uint256 indexed loanId, uint256 activatedAt, uint256 dueDate);
    event RepaymentRecorded(uint256 indexed loanId, uint256 amount, uint256 remainingOwed);
    event LoanRepaid(uint256 indexed loanId, uint256 repaidAt);
    event LoanLiquidated(uint256 indexed loanId, uint256 liquidatedAt);
    event LoanCancelled(uint256 indexed loanId);
    event CollateralManagerUpdated(address indexed oldManager, address indexed newManager);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    // ============================================
    // MODIFIERS
    // ============================================
    
    modifier onlyCollateralManager() {
        require(msg.sender == collateralManager, "Only CollateralManager");
        _;
    }

    modifier loanExists(uint256 loanId) {
        require(loans[loanId].id == loanId && loanId > 0, "Loan does not exist");
        _;
    }

    // ============================================
    // CONSTRUCTOR
    // ============================================
    
    constructor(address _treasury) Ownable(msg.sender) {
        require(_treasury != address(0), "Invalid treasury");
        treasury = _treasury;
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================
    
    /**
     * @dev Set the CollateralManager contract address
     */
    function setCollateralManager(address _collateralManager) external onlyOwner {
        require(_collateralManager != address(0), "Invalid address");
        address oldManager = collateralManager;
        collateralManager = _collateralManager;
        emit CollateralManagerUpdated(oldManager, _collateralManager);
    }

    /**
     * @dev Update the treasury address
     */
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Invalid address");
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
        uint256 principal,
        uint256 collateralRequired,
        uint256 interestRate,
        uint256 duration
    ) external onlyOwner returns (uint256) {
        require(borrower != address(0), "Invalid borrower");
        require(principal > 0, "Principal must be > 0");
        require(collateralRequired > 0, "Collateral must be > 0");
        require(duration > 0, "Duration must be > 0");

        _loanIdCounter++;
        uint256 loanId = _loanIdCounter;

        loans[loanId] = Loan({
            id: loanId,
            borrower: borrower,
            principal: principal,
            collateralRequired: collateralRequired,
            interestRate: interestRate,
            duration: duration,
            createdAt: block.timestamp,
            activatedAt: 0,
            dueDate: 0,
            principalOwed: principal,
            interestOwed: 0,
            status: LoanStatus.PendingCollateral
        });

        borrowerLoans[borrower].push(loanId);

        emit LoanCreated(loanId, borrower, principal, collateralRequired, interestRate, duration);
        
        return loanId;
    }

    /**
     * @dev Activate a loan after collateral is verified
     * Called by CollateralManager after collateral deposit
     */
    function activateLoan(uint256 loanId) external onlyCollateralManager loanExists(loanId) {
        Loan storage loan = loans[loanId];
        require(loan.status == LoanStatus.PendingCollateral, "Invalid loan status");

        loan.status = LoanStatus.Active;
        loan.activatedAt = block.timestamp;
        loan.dueDate = block.timestamp + loan.duration;
        
        // Calculate interest owed (simple interest for now)
        loan.interestOwed = (loan.principal * loan.interestRate * loan.duration) / (365 days * 10000);

        emit LoanActivated(loanId, loan.activatedAt, loan.dueDate);
    }

    /**
     * @dev Record a repayment on the loan
     * @param loanId The loan ID
     * @param amount Amount repaid in wei
     */
    function recordRepayment(
        uint256 loanId,
        uint256 amount
    ) external onlyOwner loanExists(loanId) {
        Loan storage loan = loans[loanId];
        require(loan.status == LoanStatus.Active, "Loan not active");
        require(amount > 0, "Amount must be > 0");

        uint256 totalOwed = loan.principalOwed + loan.interestOwed;
        require(amount <= totalOwed, "Amount exceeds owed");

        // Apply payment to interest first, then principal
        if (amount <= loan.interestOwed) {
            loan.interestOwed -= amount;
        } else {
            uint256 remainingAfterInterest = amount - loan.interestOwed;
            loan.interestOwed = 0;
            loan.principalOwed -= remainingAfterInterest;
        }

        uint256 remainingOwed = loan.principalOwed + loan.interestOwed;
        emit RepaymentRecorded(loanId, amount, remainingOwed);

        // Check if loan is fully repaid
        if (remainingOwed == 0) {
            loan.status = LoanStatus.Repaid;
            emit LoanRepaid(loanId, block.timestamp);
        }
    }

    /**
     * @dev Mark a loan as liquidated
     */
    function liquidateLoan(uint256 loanId) external onlyCollateralManager loanExists(loanId) {
        Loan storage loan = loans[loanId];
        require(loan.status == LoanStatus.Active, "Loan not active");
        
        loan.status = LoanStatus.Liquidated;
        emit LoanLiquidated(loanId, block.timestamp);
    }

    /**
     * @dev Cancel a loan before collateral is deposited
     */
    function cancelLoan(uint256 loanId) external loanExists(loanId) {
        Loan storage loan = loans[loanId];
        require(
            msg.sender == loan.borrower || msg.sender == owner(),
            "Not authorized"
        );
        require(loan.status == LoanStatus.PendingCollateral, "Cannot cancel");
        
        loan.status = LoanStatus.Cancelled;
        emit LoanCancelled(loanId);
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================
    
    /**
     * @dev Get loan details
     */
    function getLoan(uint256 loanId) external view returns (Loan memory) {
        return loans[loanId];
    }

    /**
     * @dev Get total amount owed on a loan
     */
    function getTotalOwed(uint256 loanId) external view loanExists(loanId) returns (uint256) {
        Loan storage loan = loans[loanId];
        return loan.principalOwed + loan.interestOwed;
    }

    /**
     * @dev Get all loan IDs for a borrower
     */
    function getBorrowerLoans(address borrower) external view returns (uint256[] memory) {
        return borrowerLoans[borrower];
    }

    /**
     * @dev Check if a loan is overdue
     */
    function isOverdue(uint256 loanId) external view loanExists(loanId) returns (bool) {
        Loan storage loan = loans[loanId];
        return loan.status == LoanStatus.Active && block.timestamp > loan.dueDate;
    }

    /**
     * @dev Get the current loan ID counter
     */
    function getCurrentLoanId() external view returns (uint256) {
        return _loanIdCounter;
    }
}
