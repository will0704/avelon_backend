// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RepaymentSchedule
 * @dev Tracks repayment schedules and milestones for loans
 * Gas-optimized with struct packing and custom errors
 */
contract RepaymentSchedule is Ownable {
    // ============================================
    // CUSTOM ERRORS
    // ============================================

    error ScheduleAlreadyExists();
    error ScheduleNotFound();
    error ScheduleAlreadyComplete();
    error InvalidAmount();
    error DueDateMustBeFuture();

    // ============================================
    // TYPES
    // ============================================

    /// @dev Packed into 2 storage slots (down from 8)
    struct Schedule {
        // Slot 1: uint128(16) + uint128(16) = 32 bytes
        uint128 totalAmount;
        uint128 amountPaid;
        // Slot 2: uint128(16) + uint48(6) + uint32(4) + uint16(2) + bool(1) = 29 bytes
        uint128 installmentAmount;
        uint48 nextDueDate;
        uint32 interval;            // Max ~136 years between payments
        uint16 installments;        // Max 65535 installments
        bool isComplete;
    }

    /// @dev Packed into 2 storage slots (down from 3)
    struct Payment {
        // Slot 1: uint128(16) + uint48(6) = 22 bytes
        uint128 amount;
        uint48 timestamp;
        // Slot 2: bytes32(32)
        bytes32 txHash;
    }

    // ============================================
    // STATE VARIABLES
    // ============================================

    // Loan ID => Schedule
    mapping(uint32 => Schedule) public schedules;

    // Loan ID => Payments
    mapping(uint32 => Payment[]) public payments;

    // ============================================
    // EVENTS
    // ============================================

    event ScheduleCreated(
        uint32 indexed loanId,
        uint128 totalAmount,
        uint16 installments,
        uint48 firstDueDate
    );
    event PaymentRecorded(uint32 indexed loanId, uint128 amount, uint128 remaining);
    event ScheduleCompleted(uint32 indexed loanId);

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
        uint32 loanId,
        uint128 totalAmount,
        uint16 installments,
        uint48 firstDueDate,
        uint32 interval
    ) external onlyOwner {
        if (schedules[loanId].totalAmount != 0) revert ScheduleAlreadyExists();
        if (totalAmount == 0) revert InvalidAmount();
        if (firstDueDate <= uint48(block.timestamp)) revert DueDateMustBeFuture();

        uint16 numInstallments = installments == 0 ? 1 : installments;
        uint128 perInstallment = totalAmount / numInstallments;

        Schedule storage schedule = schedules[loanId];
        schedule.totalAmount = totalAmount;
        schedule.installments = numInstallments;
        schedule.installmentAmount = perInstallment;
        schedule.nextDueDate = firstDueDate;
        schedule.interval = interval;

        emit ScheduleCreated(loanId, totalAmount, numInstallments, firstDueDate);
    }

    /**
     * @dev Record a payment made on a loan
     * @param loanId The loan ID
     * @param amount Amount paid
     * @param txHash Transaction hash reference
     */
    function recordPayment(
        uint32 loanId,
        uint128 amount,
        bytes32 txHash
    ) external onlyOwner {
        Schedule storage schedule = schedules[loanId];
        if (schedule.totalAmount == 0) revert ScheduleNotFound();
        if (schedule.isComplete) revert ScheduleAlreadyComplete();
        if (amount == 0) revert InvalidAmount();

        schedule.amountPaid += amount;

        // Record payment history
        payments[loanId].push(Payment({
            amount: amount,
            timestamp: uint48(block.timestamp),
            txHash: txHash
        }));

        uint128 remaining = schedule.totalAmount > schedule.amountPaid
            ? schedule.totalAmount - schedule.amountPaid
            : 0;

        emit PaymentRecorded(loanId, amount, remaining);

        // Check if fully paid
        if (schedule.amountPaid >= schedule.totalAmount) {
            schedule.isComplete = true;
            emit ScheduleCompleted(loanId);
        } else if (schedule.interval > 0) {
            // Update next due date
            schedule.nextDueDate += uint48(schedule.interval);
        }
    }

    /**
     * @dev Update schedule with additional interest/fees
     * @param loanId The loan ID
     * @param additionalAmount Amount to add
     */
    function addToSchedule(uint32 loanId, uint128 additionalAmount) external onlyOwner {
        Schedule storage schedule = schedules[loanId];
        if (schedule.totalAmount == 0) revert ScheduleNotFound();
        if (schedule.isComplete) revert ScheduleAlreadyComplete();

        schedule.totalAmount += additionalAmount;

        // Recalculate installment amount if applicable
        if (schedule.installments > 1) {
            uint128 remaining = schedule.totalAmount - schedule.amountPaid;
            uint16 remainingInstallments = _getRemainingInstallments(loanId);
            if (remainingInstallments > 0) {
                schedule.installmentAmount = remaining / uint128(remainingInstallments);
            }
        }
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /**
     * @dev Get outstanding amount for a loan
     */
    function getOutstanding(uint32 loanId) external view returns (uint128) {
        Schedule storage schedule = schedules[loanId];
        if (schedule.isComplete) return 0;
        return schedule.totalAmount > schedule.amountPaid
            ? schedule.totalAmount - schedule.amountPaid
            : 0;
    }

    /**
     * @dev Get schedule details
     */
    function getSchedule(uint32 loanId) external view returns (Schedule memory) {
        return schedules[loanId];
    }

    /**
     * @dev Get payment history for a loan
     */
    function getPayments(uint32 loanId) external view returns (Payment[] memory) {
        return payments[loanId];
    }

    /**
     * @dev Get number of payments made
     */
    function getPaymentCount(uint32 loanId) external view returns (uint256) {
        return payments[loanId].length;
    }

    /**
     * @dev Check if a payment is overdue
     */
    function isOverdue(uint32 loanId) external view returns (bool) {
        Schedule storage schedule = schedules[loanId];
        return !schedule.isComplete && block.timestamp > schedule.nextDueDate;
    }

    /**
     * @dev Get days until next payment
     */
    function getDaysUntilDue(uint32 loanId) external view returns (int256) {
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
    function _getRemainingInstallments(uint32 loanId) internal view returns (uint16) {
        Schedule storage schedule = schedules[loanId];
        uint256 paid = payments[loanId].length;
        return paid >= schedule.installments ? 0 : schedule.installments - uint16(paid);
    }

    /**
     * @dev Calculate progress percentage
     */
    function getProgress(uint32 loanId) external view returns (uint256 percentage) {
        Schedule storage schedule = schedules[loanId];
        if (schedule.totalAmount == 0) return 0;
        return (uint256(schedule.amountPaid) * 100) / schedule.totalAmount;
    }
}
