import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { blockchainService } from './blockchain.service.js';
import { contractService } from './contract.service.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../middleware/error.middleware.js';
import { LoanStatus, LoanTransactionType } from '@avelon_capstone/types';

// For Decimal type annotations
type DecimalType = Prisma.Decimal;
// For Decimal constructor usage
const PrismaDecimal = Prisma.Decimal;

interface CreateLoanInput {
    userId: string;
    walletId: string;
    planId: string;
    amount: string; // ETH amount
    duration: number; // days
}

interface LoanWithDetails {
    id: string;
    principal: DecimalType;
    collateralRequired: DecimalType;
    collateralDeposited: DecimalType;
    duration: number;
    interestRate: number;
    status: string;
    dueDate: Date | null;
    createdAt: Date;
    wallet: { address: string };
    plan: { name: string };
}

/**
 * LoanService
 * Handles loan lifecycle with database and blockchain integration
 */
export class LoanService {
    // ============================================
    // LOAN CREATION
    // ============================================

    /**
     * Create a new loan application
     */
    async createLoan(input: CreateLoanInput): Promise<LoanWithDetails> {
        const { userId, walletId, planId, amount, duration } = input;

        // Validate wallet belongs to user
        const wallet = await prisma.wallet.findFirst({
            where: { id: walletId, userId },
        });

        if (!wallet) {
            throw new NotFoundError('Wallet not found or does not belong to user');
        }

        // Get loan plan
        const plan = await prisma.loanPlan.findUnique({
            where: { id: planId },
        });

        if (!plan || !plan.isActive) {
            throw new NotFoundError('Loan plan not found or inactive');
        }

        // Validate amount
        const principal = new PrismaDecimal(amount);
        if (principal.lt(plan.minAmount) || principal.gt(plan.maxAmount)) {
            throw new ValidationError(
                `Amount must be between ${plan.minAmount} and ${plan.maxAmount} ETH`
            );
        }

        // Validate duration
        if (!plan.durationOptions.includes(duration)) {
            throw new ValidationError(
                `Duration must be one of: ${plan.durationOptions.join(', ')} days`
            );
        }

        // Check user eligibility
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { creditScore: true, status: true },
        });

        if (!user || user.creditScore === null) {
            throw new ValidationError('User does not have a credit score');
        }

        if (user.creditScore < plan.minCreditScore) {
            throw new ForbiddenError('Credit score too low for this plan');
        }

        // Calculate collateral required
        const collateralRatio = new PrismaDecimal(plan.collateralRatio).div(100);
        const collateralRequired = principal.mul(collateralRatio);

        // Calculate origination fee
        const originationFee = principal.mul(new PrismaDecimal(plan.originationFee).div(100));

        // Get current ETH price (from config for now)
        const ethPrice = new PrismaDecimal(process.env.ETH_PHP_RATE || '150000');

        // Create loan in database
        const loan = await prisma.loan.create({
            data: {
                userId,
                walletId,
                planId,
                principal,
                collateralRequired,
                duration,
                interestRate: plan.interestRate,
                originationFee,
                principalOwed: principal,
                creditScoreSnapshot: user.creditScore,
                ethPriceSnapshot: ethPrice,
                status: LoanStatus.PENDING_COLLATERAL,
            },
            include: {
                wallet: { select: { address: true } },
                plan: { select: { name: true } },
            },
        });

        // Log audit
        await prisma.auditLog.create({
            data: {
                userId,
                action: 'LOAN_CREATED',
                entity: 'Loan',
                entityId: loan.id,
                metadata: {
                    planId,
                    principal: amount,
                    duration,
                },
            },
        });

        return loan;
    }

    // ============================================
    // COLLATERAL MANAGEMENT
    // ============================================

    /**
     * Verify and record collateral deposit
     */
    async recordCollateralDeposit(
        loanId: string,
        userId: string,
        txHash: string
    ): Promise<{ success: boolean; loan: LoanWithDetails }> {
        // Get loan
        const loan = await prisma.loan.findFirst({
            where: { id: loanId, userId },
            include: {
                wallet: { select: { address: true } },
                plan: { select: { name: true } },
            },
        });

        if (!loan) {
            throw new NotFoundError('Loan not found');
        }

        if (loan.status !== LoanStatus.PENDING_COLLATERAL) {
            throw new ValidationError('Loan is not awaiting collateral');
        }

        // Verify the transaction on-chain
        const txInfo = await blockchainService.verifyTransaction(txHash);

        if (!txInfo.valid) {
            throw new ValidationError('Transaction not confirmed on blockchain');
        }

        // Record transaction
        await prisma.loanTransaction.create({
            data: {
                loanId,
                type: LoanTransactionType.COLLATERAL_DEPOSIT,
                amount: new PrismaDecimal(txInfo.value || '0'),
                txHash,
                blockNumber: txInfo.blockNumber,
                gasUsed: txInfo.gasUsed ? new PrismaDecimal(txInfo.gasUsed) : null,
                confirmed: true,
                confirmedAt: new Date(),
            },
        });

        // Update loan status
        const collateralAmount = new PrismaDecimal(txInfo.value || '0');

        const updatedLoan = await prisma.loan.update({
            where: { id: loanId },
            data: {
                collateralDeposited: { increment: collateralAmount },
                status: LoanStatus.COLLATERAL_DEPOSITED,
                collateralDepositedAt: new Date(),
            },
            include: {
                wallet: { select: { address: true } },
                plan: { select: { name: true } },
            },
        });

        // If collateral meets requirements, activate loan
        if (updatedLoan.collateralDeposited.gte(updatedLoan.collateralRequired)) {
            await this.activateLoan(loanId);
        }

        // Log audit
        await prisma.auditLog.create({
            data: {
                userId,
                action: 'COLLATERAL_DEPOSITED',
                entity: 'Loan',
                entityId: loanId,
                metadata: {
                    txHash,
                    amount: collateralAmount.toString(),
                },
            },
        });

        return { success: true, loan: updatedLoan };
    }

    /**
     * Activate a loan after collateral is deposited
     */
    private async activateLoan(loanId: string): Promise<void> {
        const loan = await prisma.loan.findUnique({
            where: { id: loanId },
        });

        if (!loan) return;

        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + loan.duration);

        // Calculate interest owed
        const interestOwed = loan.principal
            .mul(new PrismaDecimal(loan.interestRate).div(100))
            .mul(new PrismaDecimal(loan.duration).div(365));

        await prisma.loan.update({
            where: { id: loanId },
            data: {
                status: LoanStatus.ACTIVE,
                disbursedAt: new Date(),
                dueDate,
                interestOwed,
            },
        });

        // Update user stats
        await prisma.user.update({
            where: { id: loan.userId },
            data: {
                activeLoansCount: { increment: 1 },
                totalBorrowed: { increment: loan.principal },
            },
        });
    }

    // ============================================
    // REPAYMENT
    // ============================================

    /**
     * Record a loan repayment
     */
    async recordRepayment(
        loanId: string,
        userId: string,
        amount: string,
        txHash: string
    ): Promise<{ success: boolean; remainingOwed: string }> {
        // Get loan
        const loan = await prisma.loan.findFirst({
            where: { id: loanId, userId },
        });

        if (!loan) {
            throw new NotFoundError('Loan not found');
        }

        if (loan.status !== LoanStatus.ACTIVE) {
            throw new ValidationError('Loan is not active');
        }

        // Verify the transaction
        const txInfo = await blockchainService.verifyTransaction(txHash);

        if (!txInfo.valid) {
            throw new ValidationError('Transaction not confirmed on blockchain');
        }

        const repaymentAmount = new PrismaDecimal(amount);
        const totalOwed = loan.principalOwed.add(loan.interestOwed).add(loan.feesOwed);

        if (repaymentAmount.gt(totalOwed)) {
            throw new ValidationError('Repayment amount exceeds total owed');
        }

        // Record transaction
        await prisma.loanTransaction.create({
            data: {
                loanId,
                type: LoanTransactionType.REPAYMENT,
                amount: repaymentAmount,
                txHash,
                blockNumber: txInfo.blockNumber,
                gasUsed: txInfo.gasUsed ? new PrismaDecimal(txInfo.gasUsed) : null,
                confirmed: true,
                confirmedAt: new Date(),
            },
        });

        // Apply payment: fees first, then interest, then principal
        let remaining = repaymentAmount;
        let newFeesOwed = loan.feesOwed;
        let newInterestOwed = loan.interestOwed;
        let newPrincipalOwed = loan.principalOwed;

        // Pay fees
        if (remaining.gt(0) && newFeesOwed.gt(0)) {
            const feePaid = PrismaDecimal.min(remaining, newFeesOwed);
            newFeesOwed = newFeesOwed.sub(feePaid);
            remaining = remaining.sub(feePaid);
        }

        // Pay interest
        if (remaining.gt(0) && newInterestOwed.gt(0)) {
            const interestPaid = PrismaDecimal.min(remaining, newInterestOwed);
            newInterestOwed = newInterestOwed.sub(interestPaid);
            remaining = remaining.sub(interestPaid);
        }

        // Pay principal
        if (remaining.gt(0) && newPrincipalOwed.gt(0)) {
            const principalPaid = PrismaDecimal.min(remaining, newPrincipalOwed);
            newPrincipalOwed = newPrincipalOwed.sub(principalPaid);
        }

        const newTotalOwed = newPrincipalOwed.add(newInterestOwed).add(newFeesOwed);
        const isFullyRepaid = newTotalOwed.lte(0);

        // Update loan
        await prisma.loan.update({
            where: { id: loanId },
            data: {
                principalOwed: newPrincipalOwed,
                interestOwed: newInterestOwed,
                feesOwed: newFeesOwed,
                ...(isFullyRepaid && {
                    status: LoanStatus.REPAID,
                    repaidAt: new Date(),
                }),
            },
        });

        // Update user stats if fully repaid
        if (isFullyRepaid) {
            await prisma.user.update({
                where: { id: loan.userId },
                data: {
                    activeLoansCount: { decrement: 1 },
                    completedLoansCount: { increment: 1 },
                    totalRepaid: { increment: loan.principal },
                },
            });
        }

        // Log audit
        await prisma.auditLog.create({
            data: {
                userId,
                action: isFullyRepaid ? 'LOAN_REPAID' : 'REPAYMENT_RECEIVED',
                entity: 'Loan',
                entityId: loanId,
                metadata: {
                    txHash,
                    amount,
                    isFullyRepaid,
                },
            },
        });

        return {
            success: true,
            remainingOwed: newTotalOwed.toString(),
        };
    }

    // ============================================
    // LOAN QUERIES
    // ============================================

    /**
     * Get user's loans
     */
    async getUserLoans(userId: string, status?: string) {
        const where: any = { userId };
        if (status) {
            where.status = status;
        }

        return prisma.loan.findMany({
            where,
            include: {
                wallet: { select: { address: true } },
                plan: { select: { name: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Get loan by ID
     */
    async getLoanById(loanId: string, userId: string) {
        const loan = await prisma.loan.findFirst({
            where: { id: loanId, userId },
            include: {
                wallet: { select: { address: true } },
                plan: true,
                transactions: {
                    orderBy: { createdAt: 'desc' },
                    take: 10,
                },
            },
        });

        if (!loan) {
            throw new NotFoundError('Loan not found');
        }

        return loan;
    }

    /**
     * Get loan transactions
     */
    async getLoanTransactions(loanId: string, userId: string) {
        // Verify loan belongs to user
        const loan = await prisma.loan.findFirst({
            where: { id: loanId, userId },
        });

        if (!loan) {
            throw new NotFoundError('Loan not found');
        }

        return prisma.loanTransaction.findMany({
            where: { loanId },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Cancel a pending loan
     */
    async cancelLoan(loanId: string, userId: string): Promise<void> {
        const loan = await prisma.loan.findFirst({
            where: { id: loanId, userId },
        });

        if (!loan) {
            throw new NotFoundError('Loan not found');
        }

        if (loan.status !== LoanStatus.PENDING_COLLATERAL) {
            throw new ValidationError('Can only cancel loans pending collateral');
        }

        await prisma.loan.update({
            where: { id: loanId },
            data: { status: LoanStatus.CANCELLED },
        });

        await prisma.auditLog.create({
            data: {
                userId,
                action: 'LOAN_CANCELLED',
                entity: 'Loan',
                entityId: loanId,
            },
        });
    }
}

// Singleton instance
export const loanService = new LoanService();
