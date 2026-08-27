import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { blockchainService } from './blockchain.service.js';
import { contractService } from './contract.service.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../middleware/error.middleware.js';
import { LoanStatus, LoanTransactionType } from '../types/index.js';
import { notificationService } from './notification.service.js';

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
    contractLoanId?: number | null;
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

        // Prevent multiple concurrent loan applications
        const activeLoan = await prisma.loan.findFirst({
            where: {
                userId,
                status: { in: ['PENDING_COLLATERAL', 'COLLATERAL_DEPOSITED', 'ACTIVE'] },
            },
            select: { id: true, status: true },
        });

        if (activeLoan) {
            throw new ValidationError(
                `You already have an active loan application (status: ${activeLoan.status}). ` +
                `Cancel or repay it before applying for a new one.`
            );
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

        // The borrower's own stake, not security for the whole debt — the arithmetic
        // is unchanged from the over-collateralised model, only the meaning moved.
        const collateralRatio = new PrismaDecimal(plan.collateralRatio).div(100);
        const collateralRequired = principal.mul(collateralRatio);

        // Calculate origination fee
        const originationFee = principal.mul(new PrismaDecimal(plan.originationFee).div(100));

        // Get current ETH price — prefer DB SystemConfig, fall back to env var
        const priceConfig = await prisma.systemConfig.findUnique({ where: { key: 'ETH_PHP_RATE' } });
        const ethPrice = new PrismaDecimal(priceConfig?.value ?? process.env.ETH_PHP_RATE ?? '150000');

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

        // Create loan on-chain (best-effort — DB loan is authoritative if this fails)
        let contractLoanId: number | null = null;
        try {
            const onChain = await contractService.createLoan(
                wallet.address,
                amount,
                collateralRequired.toString(),
                plan.interestRate * 100,  // % to basis points
                duration * 86400           // days to seconds
            );
            contractLoanId = onChain.loanId;
            console.log(`[LoanService] On-chain loan created: contractLoanId=${contractLoanId}, txHash=${onChain.txHash}`);
        } catch (err) {
            console.error('[LoanService] On-chain loan creation failed (DB record still active):', err);
        }

        // Persist contractLoanId if on-chain call succeeded
        const finalLoan = contractLoanId !== null
            ? await prisma.loan.update({
                where: { id: loan.id },
                data: { contractLoanId },
                include: {
                    wallet: { select: { address: true } },
                    plan: { select: { name: true } },
                },
              })
            : loan;

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
                    contractLoanId,
                },
            },
        });

        return finalLoan;
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
     * Activate a loan after collateral is deposited.
     * Sends ETH from treasury to borrower's wallet, then updates DB.
     */
    private async activateLoan(loanId: string): Promise<void> {
        const loan = await prisma.loan.findUnique({
            where: { id: loanId },
            include: { wallet: true },
        });

        if (!loan || !loan.wallet) return;

        const borrowerAddress = loan.wallet.address;
        const principalEth = loan.principal.toString();

        // ── Step 1: Send ETH from treasury to borrower ──────────────────
        let disbursementTxHash: string;
        try {
            const result = await blockchainService.sendEth(borrowerAddress, principalEth);
            disbursementTxHash = result.txHash;
            console.log(`[LoanService] Disbursed ${principalEth} ETH to ${borrowerAddress} (tx: ${disbursementTxHash})`);
        } catch (err) {
            console.error(`[LoanService] ETH disbursement failed for loan ${loanId}:`, err);
            // Loan stays in COLLATERAL_DEPOSITED — no DB changes
            throw new ValidationError(
                `Loan disbursement failed. The loan remains in COLLATERAL_DEPOSITED status. Please retry later.`
            );
        }

        // ── Step 2: Update DB only after successful ETH transfer ────────
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

        // Record disbursement transaction
        await prisma.loanTransaction.create({
            data: {
                loanId,
                type: LoanTransactionType.LOAN_DISBURSEMENT,
                amount: loan.principal,
                txHash: disbursementTxHash,
                confirmed: true,
                confirmedAt: new Date(),
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

        // Track borrowed amount in pool
        try {
            await prisma.liquidityPool.updateMany({
                data: { totalBorrowed: { increment: loan.principal } },
            });
        } catch (err) {
            console.error('[LoanService] Failed to update pool totalBorrowed on disbursal:', err);
        }

        // Notify: loan disbursed
        await notificationService.notify(loan.userId, {
            type: 'LOAN_DISBURSED',
            title: '💰 Funds Disbursed',
            message: `${loan.principal} ETH has been sent to your wallet (tx: ${disbursementTxHash}). Your first repayment is due on ${dueDate.toLocaleDateString()}.`,
            metadata: { loanId, amount: loan.principal.toString(), txHash: disbursementTxHash, dueDate: dueDate.toISOString() },
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

        const totalOwed = loan.principalOwed.add(loan.interestOwed).add(loan.feesOwed);
        // Cap at totalOwed to handle minor floating-point rounding from client
        const repaymentAmount = PrismaDecimal.min(new PrismaDecimal(amount), totalOwed);

        if (new PrismaDecimal(amount).gt(totalOwed.mul(1.001))) {
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

        // Track how much interest is paid in this repayment (for revenue split)
        const interestOwedBefore = loan.interestOwed;

        // Pay fees
        if (remaining.gt(0) && newFeesOwed.gt(0)) {
            const feePaid = PrismaDecimal.min(remaining, newFeesOwed);
            newFeesOwed = newFeesOwed.sub(feePaid);
            remaining = remaining.sub(feePaid);
        }

        // Pay interest
        let interestPaid = new PrismaDecimal(0);
        if (remaining.gt(0) && newInterestOwed.gt(0)) {
            interestPaid = PrismaDecimal.min(remaining, newInterestOwed);
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

        // Sync repayment on-chain if this loan has a contract record
        if (loan.contractLoanId) {
            try {
                await contractService.recordRepayment(loan.contractLoanId, amount);
                console.log(`[LoanService] On-chain repayment recorded: contractLoanId=${loan.contractLoanId}`);
            } catch (err) {
                console.error('[LoanService] Failed to sync repayment on-chain:', err);
            }
        }

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

        // Revenue split: 90% of interest goes to liquidity pool, 10% to Avelon (treasury)
        // This happens whenever interest is paid, not just on full repayment
        if (interestPaid.gt(0)) {
            const poolShare = interestPaid.mul(0.9).toDecimalPlaces(18);
            try {
                // Update pool cumulative yield and liquidity
                await prisma.liquidityPool.updateMany({
                    data: {
                        cumulativeYield: { increment: poolShare },
                        totalBorrowed: isFullyRepaid ? { decrement: loan.principal } : undefined,
                    },
                });
                // Record yield event in pool transaction ledger
                await prisma.poolTransaction.create({
                    data: {
                        type: 'YIELD_EARNED',
                        amount: poolShare,
                        txHash,
                    },
                });
            } catch (err) {
                // Non-fatal: log but don't block repayment
                console.error('[LoanService] Failed to distribute yield to pool:', err);
            }
        } else if (isFullyRepaid) {
            // Even if no interest was paid in this repayment, reduce totalBorrowed on full repayment
            try {
                await prisma.liquidityPool.updateMany({
                    data: { totalBorrowed: { decrement: loan.principal } },
                });
            } catch (err) {
                console.error('[LoanService] Failed to update pool totalBorrowed:', err);
            }
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
        const where: { userId: string; status?: LoanStatus } = { userId };
        if (status) {
            where.status = status as LoanStatus;
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
            where: { loanId, loan: { userId } },
            orderBy: { createdAt: 'desc' },
            take: 100,
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

    // ============================================
    // LOAN CALCULATION (DRY-RUN)
    // ============================================

    /**
     * Stateless loan calculation — no DB writes
     */
    async calculateLoan(userId: string, planId: string, amount: string, duration: number) {
        const plan = await prisma.loanPlan.findUnique({ where: { id: planId } });
        if (!plan || !plan.isActive) {
            throw new NotFoundError('Loan plan not found or inactive');
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { creditScore: true },
        });

        const principal = new PrismaDecimal(amount);
        const collateralRequired = principal.mul(new PrismaDecimal(plan.collateralRatio).div(100));
        const originationFee = principal.mul(new PrismaDecimal(plan.originationFee).div(100));
        const netDisbursement = principal.sub(originationFee);
        const totalInterest = principal
            .mul(new PrismaDecimal(plan.interestRate).div(100))
            .mul(new PrismaDecimal(duration).div(365));
        const totalRepayment = principal.add(totalInterest);

        const errors: string[] = [];
        if (principal.lt(plan.minAmount)) errors.push(`Minimum amount is ${plan.minAmount} ETH`);
        if (principal.gt(plan.maxAmount)) errors.push(`Maximum amount is ${plan.maxAmount} ETH`);
        if (!plan.durationOptions.includes(duration)) {
            errors.push(`Duration must be one of: ${plan.durationOptions.join(', ')} days`);
        }
        if ((user?.creditScore ?? 0) < plan.minCreditScore) {
            errors.push(`Credit score too low for this plan (required: ${plan.minCreditScore})`);
        }

        return {
            principal: principal.toString(),
            collateralRequired: collateralRequired.toString(),
            originationFee: originationFee.toString(),
            netDisbursement: netDisbursement.toString(),
            totalInterest: totalInterest.toString(),
            totalRepayment: totalRepayment.toString(),
            eligible: errors.length === 0,
            errors,
            plan: {
                id: plan.id,
                name: plan.name,
                interestRate: plan.interestRate,
                interestType: plan.interestType,
                collateralRatio: plan.collateralRatio,
                durationOptions: plan.durationOptions,
                minAmount: plan.minAmount.toString(),
                maxAmount: plan.maxAmount.toString(),
            },
        };
    }

    // ============================================
    // LOAN EXTENSION
    // ============================================

    /**
     * Extend an active loan's due date (plan must allow it, one-time only)
     */
    async extendLoan(loanId: string, userId: string, extensionDays: number): Promise<void> {
        const loan = await prisma.loan.findFirst({
            where: { id: loanId, userId },
            include: { plan: true },
        });

        if (!loan) throw new NotFoundError('Loan not found');
        if (loan.status !== LoanStatus.ACTIVE) throw new ValidationError('Can only extend active loans');
        if (loan.extended) throw new ValidationError('Loan has already been extended');
        if (!loan.plan.extensionAllowed) throw new ForbiddenError('This loan plan does not allow extensions');
        if (extensionDays > loan.plan.maxExtensionDays) {
            throw new ValidationError(`Maximum extension is ${loan.plan.maxExtensionDays} days`);
        }
        if (!loan.dueDate) throw new ValidationError('Loan has no due date');

        const extensionFee = loan.principal.mul(new PrismaDecimal(loan.plan.extensionFee).div(100));
        const newDueDate = new Date(loan.dueDate.getTime());
        newDueDate.setDate(newDueDate.getDate() + extensionDays);

        await prisma.loan.update({
            where: { id: loanId },
            data: {
                extended: true,
                originalDueDate: loan.dueDate,
                dueDate: newDueDate,
                extensionFee,
                feesOwed: { increment: extensionFee },
            },
        });

        await notificationService.notify(userId, {
            type: 'LOAN_EXTENDED',
            title: '📅 Loan Extended',
            message: `Your loan has been extended by ${extensionDays} days. New due date: ${newDueDate.toLocaleDateString()}.`,
            metadata: { loanId, extensionDays: extensionDays.toString(), newDueDate: newDueDate.toISOString() },
        });

        await prisma.auditLog.create({
            data: {
                userId,
                action: 'LOAN_EXTENDED',
                entity: 'Loan',
                entityId: loanId,
                metadata: { extensionDays, newDueDate: newDueDate.toISOString() },
            },
        });
    }
}

// Singleton instance
export const loanService = new LoanService();
