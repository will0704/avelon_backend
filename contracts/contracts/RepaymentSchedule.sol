// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RepaymentSchedule
 * @dev Tracks repayment schedules and milestones for loans
 */
contract RepaymentSchedule is Ownable {
    // ============================================
    // TYPES
    // ============================================
    
    struct Schedule {
        uint256 loanId;
        uint256 totalAmount;        // Total amount to be repaid
        uint256 amountPaid;         // Amount already paid
        uint256 installments;       // Number of installments (0 = single payment)
        uint256 installmentAmount;  // Amount per installment
        uint256 nextDueDate;        // Next payment due date
        uint256 interval;           // Interval between payments (seconds)
        bool isComplete;
    }

    struct Payment {
        uint256 amount;
        uint256 timestamp;
        bytes32 txHash;             // Transaction hash reference
    }

    // ============================================
    // STATE VARIABLES
    // ============================================
    
    // Loan ID => Schedule
    mapping(uint256 => Schedule) public schedules;
    
    // Loan ID => Payments
    mapping(uint256 => Payment[]) public payments;
    
    // ============================================
    // EVENTS
    // ============================================
    
    event ScheduleCreated(
        uint256 indexed loanId,
        uint256 totalAmount,
        uint256 installments,
        uint256 firstDueDate
    );
    event PaymentRecorded(uint256 indexed loanId, uint256 amount, uint256 remaining);
    event ScheduleCompleted(uint256 indexed loanId);

    // ============================================
    // CONSTRUCTOR
    // ============================================
    
    constructor() Ownable(msg.sender) {}

    // ============================================
    // SCHEDULE MANAGEMENT
    // ============================================
    
    /**
     * @dev Create a repayment schedule for a loan
     * @param loanId The loan ID
     * @param totalAmount Total amount to be repaid (principal + interest)
     * @param installments Number of installments (0 or 1 for single payment)
     * @param firstDueDate Timestamp of first payment due date
     * @param interval Interval between payments in seconds
     */
    function createSchedule(
        uint256 loanId,
        uint256 totalAmount,
        uint256 installments,
        uint256 firstDueDate,
        uint256 interval
    ) external onlyOwner {
        require(schedules[loanId].loanId == 0, "Schedule exists");
        require(totalAmount > 0, "Amount must be > 0");
        require(firstDueDate > block.timestamp, "Due date must be future");

        uint256 numInstallments = installments == 0 ? 1 : installments;
        uint256 perInstallment = totalAmount / numInstallments;

        schedules[loanId] = Schedule({
            loanId: loanId,
            totalAmount: totalAmount,
            amountPaid: 0,
            installments: numInstallments,
            installmentAmount: perInstallment,
            nextDueDate: firstDueDate,
            interval: interval,
            isComplete: false
        });

        emit ScheduleCreated(loanId, totalAmount, numInstallments, firstDueDate);
    }

    /**
     * @dev Record a payment made on a loan
     * @param loanId The loan ID
     * @param amount Amount paid
     * @param txHash Transaction hash reference
     */
    function recordPayment(
        uint256 loanId,
        uint256 amount,
        bytes32 txHash
    ) external onlyOwner {
        Schedule storage schedule = schedules[loanId];
        require(schedule.loanId == loanId, "Schedule not found");
        require(!schedule.isComplete, "Already complete");
        require(amount > 0, "Amount must be > 0");

        schedule.amountPaid += amount;
        
        // Record payment history
        payments[loanId].push(Payment({
            amount: amount,
            timestamp: block.timestamp,
            txHash: txHash
        }));

        uint256 remaining = schedule.totalAmount > schedule.amountPaid 
            ? schedule.totalAmount - schedule.amountPaid 
            : 0;

        emit PaymentRecorded(loanId, amount, remaining);

        // Check if fully paid
        if (schedule.amountPaid >= schedule.totalAmount) {
            schedule.isComplete = true;
            emit ScheduleCompleted(loanId);
        } else if (schedule.interval > 0) {
            // Update next due date
            schedule.nextDueDate += schedule.interval;
        }
    }

    /**
     * @dev Update schedule with additional interest/fees
     * @param loanId The loan ID
     * @param additionalAmount Amount to add
     */
    function addToSchedule(uint256 loanId, uint256 additionalAmount) external onlyOwner {
        Schedule storage schedule = schedules[loanId];
        require(schedule.loanId == loanId, "Schedule not found");
        require(!schedule.isComplete, "Already complete");

        schedule.totalAmount += additionalAmount;
        
        // Recalculate installment amount if applicable
        if (schedule.installments > 1) {
            uint256 remaining = schedule.totalAmount - schedule.amountPaid;
            uint256 remainingInstallments = _getRemainingInstallments(loanId);
            if (remainingInstallments > 0) {
                schedule.installmentAmount = remaining / remainingInstallments;
            }
        }
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================
    
    /**
     * @dev Get outstanding amount for a loan
     */
    function getOutstanding(uint256 loanId) external view returns (uint256) {
        Schedule storage schedule = schedules[loanId];
        if (schedule.isComplete) return 0;
        return schedule.totalAmount > schedule.amountPaid 
            ? schedule.totalAmount - schedule.amountPaid 
            : 0;
    }

    /**
     * @dev Get schedule details
     */
    function getSchedule(uint256 loanId) external view returns (Schedule memory) {
        return schedules[loanId];
    }

    /**
     * @dev Get payment history for a loan
     */
    function getPayments(uint256 loanId) external view returns (Payment[] memory) {
        return payments[loanId];
    }

    /**
     * @dev Get number of payments made
     */
    function getPaymentCount(uint256 loanId) external view returns (uint256) {
        return payments[loanId].length;
    }

    /**
     * @dev Check if a payment is overdue
     */
    function isOverdue(uint256 loanId) external view returns (bool) {
        Schedule storage schedule = schedules[loanId];
        return !schedule.isComplete && block.timestamp > schedule.nextDueDate;
    }

    /**
     * @dev Get days until next payment
     */
    function getDaysUntilDue(uint256 loanId) external view returns (int256) {
        Schedule storage schedule = schedules[loanId];
        if (schedule.isComplete) return type(int256).max;
        
        if (block.timestamp >= schedule.nextDueDate) {
            return -int256((block.timestamp - schedule.nextDueDate) / 1 days);
        }
        return int256((schedule.nextDueDate - block.timestamp) / 1 days);
    }

    /**
     * @dev Calculate remaining installments
     */
    function _getRemainingInstallments(uint256 loanId) internal view returns (uint256) {
        Schedule storage schedule = schedules[loanId];
        uint256 paid = payments[loanId].length;
        return paid >= schedule.installments ? 0 : schedule.installments - paid;
    }

    /**
     * @dev Calculate progress percentage
     */
    function getProgress(uint256 loanId) external view returns (uint256 percentage) {
        Schedule storage schedule = schedules[loanId];
        if (schedule.totalAmount == 0) return 0;
        return (schedule.amountPaid * 100) / schedule.totalAmount;
    }
}
