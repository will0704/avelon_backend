// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAvelonLending {
    function activateLoan(uint256 loanId) external;
    function liquidateLoan(uint256 loanId) external;
    function getLoan(uint256 loanId) external view returns (
        uint256 id,
        address borrower,
        uint256 principal,
        uint256 collateralRequired,
        uint256 interestRate,
        uint256 duration,
        uint256 createdAt,
        uint256 activatedAt,
        uint256 dueDate,
        uint256 principalOwed,
        uint256 interestOwed,
        uint8 status
    );
}

/**
 * @title CollateralManager
 * @dev Manages ETH collateral for loans in the Avelon lending platform
 * Handles deposits, top-ups, releases, and liquidations
 */
contract CollateralManager is Ownable, ReentrancyGuard {
    // ============================================
    // STATE VARIABLES
    // ============================================
    
    IAvelonLending public lendingContract;
    
    // Collateral ratio thresholds (in basis points, 10000 = 100%)
    uint256 public minCollateralRatio = 12000;      // 120% - minimum healthy ratio
    uint256 public warningCollateralRatio = 13000;  // 130% - warning threshold
    uint256 public liquidationPenalty = 500;        // 5% penalty on liquidation
    
    // Loan ID => Collateral deposited (in wei)
    mapping(uint256 => uint256) public collateralDeposits;
    
    // Loan ID => Is collateral locked
    mapping(uint256 => bool) public isCollateralLocked;

    // ============================================
    // EVENTS
    // ============================================
    
    event CollateralDeposited(uint256 indexed loanId, address indexed depositor, uint256 amount);
    event CollateralAdded(uint256 indexed loanId, address indexed depositor, uint256 amount);
    event CollateralReleased(uint256 indexed loanId, address indexed recipient, uint256 amount);
    event CollateralLiquidated(uint256 indexed loanId, uint256 amount, uint256 penalty);
    event LendingContractUpdated(address indexed oldContract, address indexed newContract);
    event CollateralRatiosUpdated(uint256 minRatio, uint256 warningRatio);

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
        require(_lendingContract != address(0), "Invalid address");
        address oldContract = address(lendingContract);
        lendingContract = IAvelonLending(_lendingContract);
        emit LendingContractUpdated(oldContract, _lendingContract);
    }

    /**
     * @dev Update collateral ratio thresholds
     */
    function setCollateralRatios(
        uint256 _minRatio,
        uint256 _warningRatio
    ) external onlyOwner {
        require(_minRatio >= 10000, "Min ratio must be >= 100%");
        require(_warningRatio > _minRatio, "Warning must be > min");
        minCollateralRatio = _minRatio;
        warningCollateralRatio = _warningRatio;
        emit CollateralRatiosUpdated(_minRatio, _warningRatio);
    }

    /**
     * @dev Set liquidation penalty (in basis points)
     */
    function setLiquidationPenalty(uint256 _penalty) external onlyOwner {
        require(_penalty <= 2000, "Penalty too high"); // Max 20%
        liquidationPenalty = _penalty;
    }

    // ============================================
    // COLLATERAL FUNCTIONS
    // ============================================
    
    /**
     * @dev Deposit collateral for a loan
     * @param loanId The loan ID to deposit collateral for
     */
    function depositCollateral(uint256 loanId) external payable nonReentrant {
        require(msg.value > 0, "Must send ETH");
        require(address(lendingContract) != address(0), "Lending contract not set");
        
        // Get loan details
        (
            uint256 id,
            address borrower,
            ,
            uint256 collateralRequired,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            uint8 status
        ) = lendingContract.getLoan(loanId);
        
        require(id == loanId, "Loan not found");
        require(status == 0, "Loan not pending collateral"); // PendingCollateral = 0
        require(msg.sender == borrower, "Only borrower can deposit");
        require(msg.value >= collateralRequired, "Insufficient collateral");

        collateralDeposits[loanId] = msg.value;
        isCollateralLocked[loanId] = true;

        emit CollateralDeposited(loanId, msg.sender, msg.value);

        // Activate the loan in the lending contract
        lendingContract.activateLoan(loanId);
    }

    /**
     * @dev Add more collateral to an existing loan
     * @param loanId The loan ID
     */
    function addCollateral(uint256 loanId) external payable nonReentrant {
        require(msg.value > 0, "Must send ETH");
        require(isCollateralLocked[loanId], "No collateral for this loan");

        (
            ,
            address borrower,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            uint8 status
        ) = lendingContract.getLoan(loanId);

        require(status == 1, "Loan not active"); // Active = 1
        require(msg.sender == borrower, "Only borrower can add");

        collateralDeposits[loanId] += msg.value;

        emit CollateralAdded(loanId, msg.sender, msg.value);
    }

    /**
     * @dev Release collateral after loan is repaid
     * @param loanId The loan ID
     */
    function releaseCollateral(uint256 loanId) external nonReentrant onlyOwner {
        require(isCollateralLocked[loanId], "No collateral locked");
        
        (
            ,
            address borrower,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            uint8 status
        ) = lendingContract.getLoan(loanId);

        require(status == 2, "Loan not repaid"); // Repaid = 2

        uint256 amount = collateralDeposits[loanId];
        collateralDeposits[loanId] = 0;
        isCollateralLocked[loanId] = false;

        (bool success, ) = borrower.call{value: amount}("");
        require(success, "Transfer failed");

        emit CollateralReleased(loanId, borrower, amount);
    }

    /**
     * @dev Liquidate collateral for an undercollateralized or overdue loan
     * @param loanId The loan ID
     */
    function liquidate(uint256 loanId) external nonReentrant onlyOwner {
        require(isCollateralLocked[loanId], "No collateral locked");

        (
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            uint256 principalOwed,
            uint256 interestOwed,
            uint8 status
        ) = lendingContract.getLoan(loanId);

        require(status == 1, "Loan not active"); // Active = 1

        uint256 collateral = collateralDeposits[loanId];
        uint256 totalOwed = principalOwed + interestOwed;
        
        // Calculate collateral ratio
        uint256 currentRatio = (collateral * 10000) / totalOwed;
        require(currentRatio < minCollateralRatio, "Collateral ratio healthy");

        // Calculate penalty
        uint256 penalty = (collateral * liquidationPenalty) / 10000;
        uint256 amountAfterPenalty = collateral - penalty;

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
    function getCollateral(uint256 loanId) external view returns (uint256) {
        return collateralDeposits[loanId];
    }

    /**
     * @dev Calculate current collateral ratio for a loan
     * @return ratio Collateral ratio in basis points (10000 = 100%)
     */
    function getCollateralRatio(uint256 loanId) external view returns (uint256 ratio) {
        uint256 collateral = collateralDeposits[loanId];
        if (collateral == 0) return 0;

        (
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            uint256 principalOwed,
            uint256 interestOwed,
            
        ) = lendingContract.getLoan(loanId);

        uint256 totalOwed = principalOwed + interestOwed;
        if (totalOwed == 0) return type(uint256).max;

        return (collateral * 10000) / totalOwed;
    }

    /**
     * @dev Check if a loan is at risk of liquidation
     */
    function isAtRisk(uint256 loanId) external view returns (bool warning, bool liquidatable) {
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
        require(to != address(0), "Invalid address");
        require(amount <= address(this).balance, "Insufficient balance");
        
        (bool success, ) = to.call{value: amount}("");
        require(success, "Transfer failed");
    }

    /**
     * @dev Receive ETH
     */
    receive() external payable {}
}
