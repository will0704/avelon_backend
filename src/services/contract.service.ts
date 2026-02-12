import { ethers } from 'ethers';
import { blockchainService } from './blockchain.service.js';

/**
 * ContractService
 * High-level service for interacting with deployed smart contracts
 */
export class ContractService {
    // ============================================
    // AVELON LENDING CONTRACT OPERATIONS
    // ============================================

    /**
     * Create a loan on-chain
     */
    async createLoan(
        borrowerAddress: string,
        principal: string,
        collateralRequired: string,
        interestRate: number,
        durationSeconds: number
    ): Promise<{ loanId: number; txHash: string }> {
        const contract = blockchainService.getAvelonLending();

        const tx = await contract.createLoan(
            borrowerAddress,
            ethers.parseEther(principal),
            ethers.parseEther(collateralRequired),
            interestRate, // in basis points
            durationSeconds
        );

        const receipt = await tx.wait();

        // Parse the LoanCreated event to get the loan ID
        const event = receipt.logs.find(
            (log: any) => log.fragment?.name === 'LoanCreated'
        );

        const loanId = event ? Number(event.args[0]) : 0;

        return {
            loanId,
            txHash: receipt.hash,
        };
    }

    /**
     * Get loan details from chain
     */
    async getLoan(loanId: number) {
        const contract = blockchainService.getAvelonLending();
        const loan = await contract.getLoan(loanId);

        return {
            id: Number(loan.id),
            borrower: loan.borrower,
            principal: ethers.formatEther(loan.principal),
            collateralRequired: ethers.formatEther(loan.collateralRequired),
            interestRate: Number(loan.interestRate),
            duration: Number(loan.duration),
            createdAt: Number(loan.createdAt),
            activatedAt: Number(loan.activatedAt),
            dueDate: Number(loan.dueDate),
            principalOwed: ethers.formatEther(loan.principalOwed),
            interestOwed: ethers.formatEther(loan.interestOwed),
            status: Number(loan.status),
        };
    }

    /**
     * Get total amount owed on a loan
     */
    async getTotalOwed(loanId: number): Promise<string> {
        const contract = blockchainService.getAvelonLending();
        const total = await contract.getTotalOwed(loanId);
        return ethers.formatEther(total);
    }

    /**
     * Record a repayment on-chain
     */
    async recordRepayment(
        loanId: number,
        amount: string
    ): Promise<{ txHash: string; remainingOwed: string }> {
        const contract = blockchainService.getAvelonLending();

        const tx = await contract.recordRepayment(
            loanId,
            ethers.parseEther(amount)
        );

        const receipt = await tx.wait();

        // Get updated owed amount
        const remainingOwed = await this.getTotalOwed(loanId);

        return {
            txHash: receipt.hash,
            remainingOwed,
        };
    }

    /**
     * Cancel a pending loan
     */
    async cancelLoan(loanId: number): Promise<string> {
        const contract = blockchainService.getAvelonLending();
        const tx = await contract.cancelLoan(loanId);
        const receipt = await tx.wait();
        return receipt.hash;
    }

    /**
     * Check if a loan is overdue
     */
    async isLoanOverdue(loanId: number): Promise<boolean> {
        const contract = blockchainService.getAvelonLending();
        return contract.isOverdue(loanId);
    }

    /**
     * Get borrower's loan IDs
     */
    async getBorrowerLoans(borrowerAddress: string): Promise<number[]> {
        const contract = blockchainService.getAvelonLending();
        const loanIds = await contract.getBorrowerLoans(borrowerAddress);
        return loanIds.map((id: bigint) => Number(id));
    }

    // ============================================
    // COLLATERAL MANAGER CONTRACT OPERATIONS
    // ============================================

    /**
     * Get collateral amount for a loan
     */
    async getCollateral(loanId: number): Promise<string> {
        const contract = blockchainService.getCollateralManager();
        const collateral = await contract.getCollateral(loanId);
        return ethers.formatEther(collateral);
    }

    /**
     * Get collateral ratio for a loan
     */
    async getCollateralRatio(loanId: number): Promise<number> {
        const contract = blockchainService.getCollateralManager();
        const ratio = await contract.getCollateralRatio(loanId);
        return Number(ratio) / 100; // Convert from basis points to percentage
    }

    /**
     * Check if loan is at risk
     */
    async isLoanAtRisk(loanId: number): Promise<{ warning: boolean; liquidatable: boolean }> {
        const contract = blockchainService.getCollateralManager();
        const [warning, liquidatable] = await contract.isAtRisk(loanId);
        return { warning, liquidatable };
    }

    /**
     * Verify a collateral deposit transaction
     */
    async verifyCollateralDeposit(
        loanId: number,
        txHash: string
    ): Promise<{ verified: boolean; amount?: string; error?: string }> {
        try {
            // Get transaction details
            const txInfo = await blockchainService.verifyTransaction(txHash);

            if (!txInfo.valid) {
                return { verified: false, error: 'Transaction not confirmed' };
            }

            // Check if tx was sent to CollateralManager
            const cmAddress = process.env.COLLATERAL_MANAGER_ADDRESS;
            if (txInfo.to?.toLowerCase() !== cmAddress?.toLowerCase()) {
                return { verified: false, error: 'Transaction not sent to CollateralManager' };
            }

            // Get current collateral amount
            const collateral = await this.getCollateral(loanId);

            return {
                verified: true,
                amount: collateral,
            };
        } catch (error) {
            return {
                verified: false,
                error: error instanceof Error ? error.message : 'Verification failed'
            };
        }
    }

    /**
     * Release collateral for a repaid loan
     */
    async releaseCollateral(loanId: number): Promise<string> {
        const contract = blockchainService.getCollateralManager();
        const tx = await contract.releaseCollateral(loanId);
        const receipt = await tx.wait();
        return receipt.hash;
    }

    /**
     * Liquidate undercollateralized loan
     */
    async liquidateLoan(loanId: number): Promise<string> {
        const contract = blockchainService.getCollateralManager();
        const tx = await contract.liquidate(loanId);
        const receipt = await tx.wait();
        return receipt.hash;
    }

    // ============================================
    // REPAYMENT SCHEDULE CONTRACT OPERATIONS
    // ============================================

    /**
     * Create a repayment schedule
     */
    async createRepaymentSchedule(
        loanId: number,
        totalAmount: string,
        installments: number,
        firstDueDate: number,
        intervalSeconds: number
    ): Promise<string> {
        const contract = blockchainService.getRepaymentSchedule();

        const tx = await contract.createSchedule(
            loanId,
            ethers.parseEther(totalAmount),
            installments,
            firstDueDate,
            intervalSeconds
        );

        const receipt = await tx.wait();
        return receipt.hash;
    }

    /**
     * Record a payment in the schedule
     */
    async recordSchedulePayment(
        loanId: number,
        amount: string,
        txHash: string
    ): Promise<string> {
        const contract = blockchainService.getRepaymentSchedule();

        const tx = await contract.recordPayment(
            loanId,
            ethers.parseEther(amount),
            ethers.encodeBytes32String(txHash.slice(0, 31)) // Truncate to fit bytes32
        );

        const receipt = await tx.wait();
        return receipt.hash;
    }

    /**
     * Get outstanding amount from schedule
     */
    async getOutstandingAmount(loanId: number): Promise<string> {
        const contract = blockchainService.getRepaymentSchedule();
        const outstanding = await contract.getOutstanding(loanId);
        return ethers.formatEther(outstanding);
    }

    /**
     * Get repayment schedule details
     */
    async getSchedule(loanId: number) {
        const contract = blockchainService.getRepaymentSchedule();
        const schedule = await contract.getSchedule(loanId);

        return {
            loanId: Number(schedule.loanId),
            totalAmount: ethers.formatEther(schedule.totalAmount),
            amountPaid: ethers.formatEther(schedule.amountPaid),
            installments: Number(schedule.installments),
            installmentAmount: ethers.formatEther(schedule.installmentAmount),
            nextDueDate: Number(schedule.nextDueDate),
            interval: Number(schedule.interval),
            isComplete: schedule.isComplete,
        };
    }

    /**
     * Check if payment is overdue
     */
    async isPaymentOverdue(loanId: number): Promise<boolean> {
        const contract = blockchainService.getRepaymentSchedule();
        return contract.isOverdue(loanId);
    }

    /**
     * Get repayment progress percentage
     */
    async getRepaymentProgress(loanId: number): Promise<number> {
        const contract = blockchainService.getRepaymentSchedule();
        const progress = await contract.getProgress(loanId);
        return Number(progress);
    }
}

// Singleton instance
export const contractService = new ContractService();
