import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { blockchainService } from './blockchain.service.js';
import { contractService } from './contract.service.js';
import { AppError, NotFoundError, ValidationError, ForbiddenError } from '../middleware/error.middleware.js';
import { LoanStatus, LoanTransactionType } from '../types/index.js';
import { notificationService } from './notification.service.js';
import { chain } from '../config/env.js';
import { poolService } from './pool.service.js';

// For Decimal type annotations
type DecimalType = Prisma.Decimal;
// For Decimal constructor usage
const PrismaDecimal = Prisma.Decimal;

/**
 * Round an amount to wei.
 *
 * Prisma Decimals carry 30 places, so a rate like 12%/365 days produces a figure
 * with more precision than ETH has. Quoting a balance the chain cannot express
 * leaves the borrower unable to pay it off exactly, and the loan never closes.
 */
const WEI_DP = 18;
const toWei = (value: Prisma.Decimal) => value.toDecimalPlaces(WEI_DP, Prisma.Decimal.ROUND_DOWN);

interface CreateLoanInput {
    userId: string;
    walletId: string;
    planId: string;
    amount: string; // ETH amount
    duration: number; // days
    purpose: string;
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
        const { userId, walletId, planId, amount, duration, purpose } = input;

        // Validate wallet belongs to user
        const wallet = await prisma.wallet.findFirst({
            where: { id: walletId, userId },
        });

        if (!wallet || !wallet.isVerified) {
            throw new NotFoundError('Wallet not found or does not belong to user');
        }
        if (wallet.chainId !== chain.id) {
            throw new ValidationError(`Wallet must be verified on chain ${chain.id}`);
        }

        // Prevent multiple concurrent loan applications
        const activeLoan = await prisma.loan.findFirst({
            where: {
                userId,
                status: { in: ['PENDING_APPROVAL', 'PENDING_COLLATERAL', 'COLLATERAL_DEPOSITED', 'ACTIVE'] },
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
        const collateralRequired = toWei(principal.mul(collateralRatio));

        // Calculate origination fee
        const originationFee = toWei(principal.mul(new PrismaDecimal(plan.originationFee).div(100)));

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
                purpose,
                interestRate: plan.interestRate,
                originationFee,
                principalOwed: principal,
                creditScoreSnapshot: user.creditScore,
                ethPriceSnapshot: ethPrice,
                status: LoanStatus.PENDING_APPROVAL,
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
                action: 'LOAN_APPLICATION_SUBMITTED',
                entity: 'Loan',
                entityId: loan.id,
                metadata: { planId, principal: amount, duration, purpose },
            },
        });

        return loan;
    }

    // ============================================
    // ADMIN DECISION
    // ============================================

    /**
     * Approve an application and give it its on-chain identity.
     *
     * The chain write happens here rather than at application time, so a rejected
     * application never costs gas and never leaves an orphan loan on-chain.
     */
    async approveLoan(loanId: string, adminId: string) {
        const loan = await prisma.loan.findUnique({
            where: { id: loanId },
            include: { wallet: true, plan: true },
        });

        if (!loan) throw new NotFoundError('Loan not found');
        if (loan.status !== LoanStatus.PENDING_APPROVAL) {
            throw new ValidationError(`Loan is ${loan.status}, not awaiting approval`);
        }
        if (!loan.wallet?.isVerified) {
            throw new ValidationError('Borrower wallet is no longer verified');
        }

        let contractLoanId: number;
        try {
            const onChain = await contractService.createLoan(
                loan.wallet.address,
                loan.principal.toString(),
                loan.collateralRequired.toString(),
                Math.round(loan.interestRate * 100),  // % to basis points
                loan.duration * 86400                  // days to seconds
            );
            contractLoanId = onChain.loanId;
            console.log(`[LoanService] On-chain loan created: contractLoanId=${contractLoanId}, txHash=${onChain.txHash}`);
        } catch (err) {
            console.error('[LoanService] On-chain loan creation failed; application stays pending:', err);
            throw new ValidationError('Could not create the on-chain loan. The application remains pending.');
        }

        const approved = await prisma.loan.update({
            where: { id: loanId },
            data: {
                contractLoanId,
                status: LoanStatus.PENDING_COLLATERAL,
                approvedAt: new Date(),
                approvedBy: adminId,
            },
            include: {
                wallet: { select: { address: true } },
                plan: { select: { name: true } },
            },
        });

        await prisma.auditLog.create({
            data: {
                userId: adminId,
                action: 'LOAN_APPROVED',
                entity: 'Loan',
                entityId: loanId,
                metadata: { borrowerId: loan.userId, contractLoanId, principal: loan.principal.toString() },
            },
        });

        await notificationService.notify(loan.userId, {
            type: 'LOAN_APPROVED',
            title: '✅ Loan Approved',
            message: `Your ${loan.principal} ETH loan was approved. Deposit your ${loan.collateralRequired} ETH stake to receive the funds.`,
            metadata: { loanId, collateralRequired: loan.collateralRequired.toString() },
        });

        return approved;
    }

    /** Reject an application with a reason the borrower can read. */
    async rejectLoan(loanId: string, adminId: string, reason: string) {
        const loan = await prisma.loan.findUnique({ where: { id: loanId } });

        if (!loan) throw new NotFoundError('Loan not found');
        if (loan.status !== LoanStatus.PENDING_APPROVAL) {
            throw new ValidationError(`Loan is ${loan.status}, not awaiting approval`);
        }

        const rejected = await prisma.loan.update({
            where: { id: loanId },
            data: {
                status: LoanStatus.REJECTED,
                rejectedAt: new Date(),
                rejectedBy: adminId,
                rejectionReason: reason,
            },
            include: {
                wallet: { select: { address: true } },
                plan: { select: { name: true } },
            },
        });

        await prisma.auditLog.create({
            data: {
                userId: adminId,
                action: 'LOAN_REJECTED',
                entity: 'Loan',
                entityId: loanId,
                metadata: { borrowerId: loan.userId, reason },
            },
        });

        await notificationService.notify(loan.userId, {
            type: 'LOAN_REJECTED',
            title: '❌ Loan Application Rejected',
            message: `Your ${loan.principal} ETH application was not approved. Reason: ${reason}`,
            metadata: { loanId, reason },
        });

        return rejected;
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
        if (loan.contractLoanId === null) {
            throw new ValidationError('Loan has no on-chain identity; do not send collateral');
        }

        const existingTransaction = await prisma.loanTransaction.findUnique({ where: { txHash } });
        if (existingTransaction) {
            throw new ValidationError('Transaction hash has already been used');
        }

        const verification = await contractService.verifyCollateralDeposit(
            loan.contractLoanId,
            txHash,
            loan.wallet.address,
            loan.collateralRequired.toString(),
        );
        if (!verification.verified || !verification.amount) {
            throw new ValidationError(verification.error || 'Collateral deposit could not be verified');
        }

        const collateralAmount = new PrismaDecimal(verification.amount);

        const [, updatedLoan] = await prisma.$transaction([
            prisma.loanTransaction.create({
                data: {
                    loanId,
                    type: LoanTransactionType.COLLATERAL_DEPOSIT,
                    amount: collateralAmount,
                    txHash,
                    blockNumber: verification.blockNumber,
                    gasUsed: verification.gasUsed ? new PrismaDecimal(verification.gasUsed) : null,
                    confirmed: true,
                    confirmedAt: new Date(),
                },
            }),
            prisma.loan.update({
                where: { id: loanId },
                data: {
                    collateralDeposited: collateralAmount,
                    status: LoanStatus.COLLATERAL_DEPOSITED,
                    collateralDepositedAt: new Date(),
                },
                include: {
                    wallet: { select: { address: true } },
                    plan: { select: { name: true } },
                },
            }),
        ]);

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

        const finalLoan = await prisma.loan.findUnique({
            where: { id: loanId },
            include: {
                wallet: { select: { address: true } },
                plan: { select: { name: true } },
            },
        });
        return { success: true, loan: finalLoan ?? updatedLoan };
    }

    /**
     * Activate a loan after collateral is deposited.
     *
     * The principal comes out of the investor pool, not a platform wallet, so a
     * loan can only disburse when investors have actually funded it. The pool
     * records the borrower and the amount, which is what later lets a repayment
     * be matched back to the right position.
     */
    private async activateLoan(loanId: string): Promise<void> {
        const loan = await prisma.loan.findUnique({
            where: { id: loanId },
            include: { wallet: true },
        });

        if (!loan || !loan.wallet) return;

        const borrowerAddress = loan.wallet.address;
        const disbursementAmount = loan.principal.sub(loan.originationFee);
        if (disbursementAmount.lte(0)) {
            throw new ValidationError('Origination fee leaves no disbursable principal');
        }
        const principalEth = disbursementAmount.toString();

        const existingDisbursement = await prisma.loanTransaction.findFirst({
            where: { loanId, type: LoanTransactionType.LOAN_DISBURSEMENT },
        });
        if (existingDisbursement) {
            throw new ValidationError('Disbursement already exists and requires reconciliation; it will not be sent twice');
        }

        if (loan.contractLoanId === null) {
            throw new ValidationError('Loan has no on-chain identity and cannot be funded');
        }

        // ── Step 1: Pay the borrower out of the investor pool ───────────
        let disbursementTxHash: string;
        try {
            const result = await poolService.fundLoan(loan.contractLoanId, borrowerAddress, principalEth);
            disbursementTxHash = result.txHash;
            console.log(`[LoanService] Pool funded ${principalEth} ETH to ${borrowerAddress} (tx: ${disbursementTxHash})`);
        } catch (err) {
            console.error(`[LoanService] Pool disbursement failed for loan ${loanId}:`, err);
            // Loan stays in COLLATERAL_DEPOSITED — no DB changes. Surface the pool's
            // own message so "not enough liquidity" does not read as a system fault.
            if (err instanceof AppError) throw err;
            throw new ValidationError(
                `Loan disbursement failed. The loan remains in COLLATERAL_DEPOSITED status. Please retry later.`
            );
        }

        // ── Step 2: Update DB only after successful ETH transfer ────────
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + loan.duration);

        // Calculate interest owed
        const interestOwed = toWei(
            loan.principal
                .mul(new PrismaDecimal(loan.interestRate).div(100))
                .mul(new PrismaDecimal(loan.duration).div(365)),
        );

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
                amount: disbursementAmount,
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

        // Mirror the pool's own numbers rather than incrementing a local counter,
        // which would drift the moment a repayment or write-off landed.
        try {
            await this._syncPoolMirror();
        } catch (err) {
            console.error('[LoanService] Failed to refresh pool mirror on disbursal:', err);
        }

        // Notify: loan disbursed
        await notificationService.notify(loan.userId, {
            type: 'LOAN_DISBURSED',
            title: '💰 Funds Disbursed',
            message: `${disbursementAmount} ETH has been released from the investor pool after withholding the ${loan.originationFee} ETH origination fee (tx: ${disbursementTxHash}). Your repayment is due on ${dueDate.toLocaleDateString()}.`,
            metadata: { loanId, grossPrincipal: loan.principal.toString(), disbursedAmount: disbursementAmount.toString(), originationFee: loan.originationFee.toString(), txHash: disbursementTxHash, dueDate: dueDate.toISOString() },
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

        if (loan.contractLoanId === null) {
            throw new ValidationError('Loan has no on-chain identity and requires manual reconciliation');
        }

        const existingTransaction = await prisma.loanTransaction.findUnique({ where: { txHash } });
        if (existingTransaction) {
            throw new ValidationError('Transaction hash has already been used');
        }

        // Verify the actual value transfer. The chain, not the client amount,
        // is authoritative for debt reduction.
        const txInfo = await blockchainService.verifyTransaction(txHash);

        if (!txInfo.valid) {
            throw new ValidationError(`Transaction is not successful or lacks ${chain.minConfirmations} confirmation(s)`);
        }
        if (txInfo.chainId !== chain.id) {
            throw new ValidationError(`Transaction is on chain ${txInfo.chainId}, expected ${chain.id}`);
        }

        const wallet = await prisma.wallet.findUnique({ where: { id: loan.walletId } });
        if (!wallet?.isVerified || txInfo.from?.toLowerCase() !== wallet.address.toLowerCase()) {
            throw new ValidationError('Repayment sender is not the verified borrower wallet');
        }
        const poolAddress = poolService.getAddress();
        if (!poolAddress) {
            throw new ValidationError('No liquidity pool is configured to receive repayments');
        }
        if (txInfo.to?.toLowerCase() !== poolAddress.toLowerCase()) {
            throw new ValidationError('Repayment was not sent to the Avelon liquidity pool');
        }
        // A plain transfer would land as an untracked donation, so the call itself
        // has to name the loan it settles.
        const call = txInfo.data ? blockchainService.decodePoolCall(txInfo.data) : null;
        if (!call || call.name !== 'repay') {
            throw new ValidationError('Repayment must call repay(loanId) on the liquidity pool');
        }
        if (Number(call.args[0]) !== loan.contractLoanId) {
            throw new ValidationError(`Repayment settles loan ${call.args[0]}, not loan ${loan.contractLoanId}`);
        }
        if (!txInfo.value) {
            throw new ValidationError('Repayment transaction value is unavailable');
        }

        const credited = await blockchainService.findPoolRepaymentEvent(
            txHash,
            poolAddress,
            loan.contractLoanId,
        );
        if (!credited) {
            throw new ValidationError('The pool did not record a repayment for this loan in that transaction');
        }

        const totalOwed = loan.principalOwed.add(loan.interestOwed).add(loan.feesOwed);
        const submittedAmount = new PrismaDecimal(amount);
        const repaymentAmount = new PrismaDecimal(txInfo.value);
        if (!repaymentAmount.eq(submittedAmount)) {
            throw new ValidationError(`Submitted amount does not match the on-chain transfer of ${repaymentAmount} ETH`);
        }
        if (repaymentAmount.lte(0)) {
            throw new ValidationError('Repayment amount must be greater than zero');
        }
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

        // Chain state is authoritative. Never mark the database repaid while the
        // on-chain loan/collateral still says otherwise.
        await contractService.recordRepayment(loan.contractLoanId, repaymentAmount.toString());
        if (isFullyRepaid) {
            await contractService.releaseCollateral(loan.contractLoanId);
        }

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

        // What the pool actually credited, taken from its own event rather than
        // recomputed here. Interest is not split with the platform: every ETH of it
        // lifts share value, so it reaches investors directly.
        try {
            await prisma.poolTransaction.create({
                data: {
                    type: 'YIELD_EARNED',
                    amount: new PrismaDecimal(credited.interest),
                    txHash,
                },
            });
            await this._syncPoolMirror();
        } catch (err) {
            // Non-fatal: the repayment itself is already settled on-chain
            console.error('[LoanService] Failed to record pool yield:', err);
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
                    amount: repaymentAmount.toString(),
                    isFullyRepaid,
                },
            },
        });

        return {
            success: true,
            remainingOwed: newTotalOwed.toString(),
        };
    }

    /**
     * Refresh the LiquidityPool mirror row after a repayment.
     *
     * Reporting reads the pool contract directly; this row only backs admin
     * analytics, so a failure must never fail a settled repayment.
     */
    private async _syncPoolMirror(): Promise<void> {
        if (!poolService.isConfigured()) return;
        const state = await poolService.getPoolState();
        const pool = await prisma.liquidityPool.findFirst();
        const data = {
            totalLiquidity: new PrismaDecimal(state.totalAssets),
            totalBorrowed: new PrismaDecimal(state.totalOutstandingPrincipal),
            cumulativeYield: new PrismaDecimal(state.cumulativeInterest),
            utilizationRate: state.utilization,
            poolAddress: state.address,
        };
        if (pool) {
            await prisma.liquidityPool.update({ where: { id: pool.id }, data });
        } else {
            await prisma.liquidityPool.create({ data });
        }
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
        const collateralRequired = toWei(principal.mul(new PrismaDecimal(plan.collateralRatio).div(100)));
        const originationFee = toWei(principal.mul(new PrismaDecimal(plan.originationFee).div(100)));
        const netDisbursement = principal.sub(originationFee);
        const totalInterest = principal
            .mul(new PrismaDecimal(plan.interestRate).div(100))
            .mul(new PrismaDecimal(duration).div(365))
            .toDecimalPlaces(WEI_DP, Prisma.Decimal.ROUND_DOWN);
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

        const extensionFee = toWei(loan.principal.mul(new PrismaDecimal(loan.plan.extensionFee).div(100)));
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
