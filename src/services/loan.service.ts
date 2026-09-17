import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { blockchainService } from './blockchain.service.js';
import { contractService, LiquidationReason } from './contract.service.js';
import { AppError, NotFoundError, ValidationError, ForbiddenError } from '../middleware/error.middleware.js';
import { LoanStatus, LoanTransactionType } from '../types/index.js';
import { notificationService } from './notification.service.js';
import { chain } from '../config/env.js';
import { poolService } from './pool.service.js';
import { isUniqueViolation, normalizeTxHash } from '../lib/tx-hash.js';

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
const totalOwedOf = (loan: { principalOwed: DecimalType; interestOwed: DecimalType; feesOwed: DecimalType }) =>
    loan.principalOwed.add(loan.interestOwed).add(loan.feesOwed);

// An approval claim older than this is treated as abandoned (the process died
// between the claim and the chain write).
const APPROVAL_CLAIM_TTL_MS = 5 * 60 * 1000;

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

        // Get loan plan
        const plan = await prisma.loanPlan.findUnique({
            where: { id: planId },
        });

        if (!plan || !plan.isActive) {
            throw new NotFoundError('Loan plan not found or inactive');
        }

        // Validate amount
        const principal = new PrismaDecimal(amount);
        if (principal.decimalPlaces() > WEI_DP) {
            throw new ValidationError('Amount can have at most 18 decimal places');
        }
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

        // The open-loan check and the insert run under a per-borrower lock, so a
        // double-tapped Apply cannot create two applications.
        const creditScore = user.creditScore;

        return prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

            const activeLoan = await tx.loan.findFirst({
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

            const loan = await tx.loan.create({
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
                    creditScoreSnapshot: creditScore,
                    ethPriceSnapshot: ethPrice,
                    status: LoanStatus.PENDING_APPROVAL,
                },
                include: {
                    wallet: { select: { address: true } },
                    plan: { select: { name: true } },
                },
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    action: 'LOAN_APPLICATION_SUBMITTED',
                    entity: 'Loan',
                    entityId: loan.id,
                    metadata: { planId, principal: amount, duration, purpose },
                },
            });

            return loan;
        });
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

        // Claim the application first. Two admins approving at once would
        // otherwise each create an on-chain loan.
        const claimed = await prisma.loan.updateMany({
            where: {
                id: loanId,
                status: LoanStatus.PENDING_APPROVAL,
                OR: [
                    { approvedBy: null },
                    { approvedAt: { lt: new Date(Date.now() - APPROVAL_CLAIM_TTL_MS) } },
                ],
            },
            data: { approvedBy: adminId, approvedAt: new Date() },
        });
        if (claimed.count !== 1) {
            throw new ValidationError('This loan is already being approved');
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
            await prisma.loan.updateMany({
                where: { id: loanId, status: LoanStatus.PENDING_APPROVAL, approvedBy: adminId },
                data: { approvedBy: null },
            });
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

        // Not while another admin's approval is writing to the chain
        const moved = await prisma.loan.updateMany({
            where: { id: loanId, status: LoanStatus.PENDING_APPROVAL, approvedBy: null },
            data: {
                status: LoanStatus.REJECTED,
                rejectedAt: new Date(),
                rejectedBy: adminId,
                rejectionReason: reason,
            },
        });
        if (moved.count !== 1) {
            throw new ValidationError('This loan is being approved and can no longer be rejected');
        }

        const rejected = await prisma.loan.findUniqueOrThrow({
            where: { id: loanId },
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
    ): Promise<{ success: boolean; loan: LoanWithDetails; payoutPending: boolean }> {
        const hash = normalizeTxHash(txHash);

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

        const existingTransaction = await prisma.loanTransaction.findUnique({ where: { txHash: hash } });
        if (existingTransaction) {
            throw new ValidationError('Transaction hash has already been used');
        }

        const verification = await contractService.verifyCollateralDeposit(
            loan.contractLoanId,
            hash,
            loan.wallet.address,
            loan.collateralRequired.toString(),
        );
        if (!verification.verified || !verification.amount) {
            throw new ValidationError(verification.error || 'Collateral deposit could not be verified');
        }

        const collateralAmount = new PrismaDecimal(verification.amount);

        try {
            await prisma.$transaction(async (tx) => {
                // Conditional on the status, so a second request for the same loan loses
                const moved = await tx.loan.updateMany({
                    where: { id: loanId, status: LoanStatus.PENDING_COLLATERAL },
                    data: {
                        collateralDeposited: collateralAmount,
                        status: LoanStatus.COLLATERAL_DEPOSITED,
                        collateralDepositedAt: new Date(),
                    },
                });
                if (moved.count !== 1) {
                    throw new ValidationError('Loan is no longer awaiting collateral');
                }
                await tx.loanTransaction.create({
                    data: {
                        loanId,
                        type: LoanTransactionType.COLLATERAL_DEPOSIT,
                        amount: collateralAmount,
                        txHash: hash,
                        blockNumber: verification.blockNumber,
                        gasUsed: verification.gasUsed ? new PrismaDecimal(verification.gasUsed) : null,
                        confirmed: true,
                        confirmedAt: new Date(),
                    },
                });
            });
        } catch (err) {
            if (isUniqueViolation(err)) throw new ValidationError('Transaction hash has already been used');
            throw err;
        }

        await prisma.auditLog.create({
            data: {
                userId,
                action: 'COLLATERAL_DEPOSITED',
                entity: 'Loan',
                entityId: loanId,
                metadata: {
                    txHash: hash,
                    amount: collateralAmount.toString(),
                },
            },
        });

        // The deposit is on record whatever happens next. A payout the pool cannot
        // make yet leaves the loan in COLLATERAL_DEPOSITED for retryDisbursement.
        let payoutPending = false;
        try {
            await this.activateLoan(loanId);
        } catch (err) {
            payoutPending = true;
            console.error(`[LoanService] Payout pending for loan ${loanId}:`, err);
            await notificationService.notify(userId, {
                type: 'COLLATERAL_DEPOSITED',
                title: 'Stake received — payout pending',
                message: 'Your stake is safely recorded. The payout is waiting on pool funds and will be sent as soon as it can.',
                metadata: { loanId },
            });
        }

        const finalLoan = await prisma.loan.findUnique({
            where: { id: loanId },
            include: {
                wallet: { select: { address: true } },
                plan: { select: { name: true } },
            },
        });
        return { success: true, loan: (finalLoan ?? loan) as LoanWithDetails, payoutPending };
    }

    /** Send a payout that failed when the collateral was recorded. */
    async retryDisbursement(loanId: string) {
        const loan = await prisma.loan.findUnique({ where: { id: loanId } });
        if (!loan) throw new NotFoundError('Loan not found');
        if (loan.status !== LoanStatus.COLLATERAL_DEPOSITED) {
            throw new ValidationError(`Loan is ${loan.status}, not waiting for a payout`);
        }

        await this.activateLoan(loanId);

        return prisma.loan.findUnique({
            where: { id: loanId },
            include: {
                wallet: { select: { address: true } },
                plan: { select: { name: true } },
            },
        });
    }

    /**
     * Record a stake top-up on an active loan. The borrower calls
     * CollateralManager.addCollateral(loanId) directly.
     */
    async recordAdditionalCollateral(loanId: string, userId: string, txHash: string) {
        const hash = normalizeTxHash(txHash);

        const loan = await prisma.loan.findFirst({
            where: { id: loanId, userId },
            include: { wallet: { select: { address: true } } },
        });
        if (!loan) throw new NotFoundError('Loan not found');
        if (loan.status !== LoanStatus.ACTIVE) {
            throw new ValidationError('Extra collateral can only be added to an active loan');
        }
        if (loan.contractLoanId === null) {
            throw new ValidationError('Loan has no on-chain identity and requires manual reconciliation');
        }

        const existingTransaction = await prisma.loanTransaction.findUnique({ where: { txHash: hash } });
        if (existingTransaction) {
            throw new ValidationError('Transaction hash has already been used');
        }

        const verification = await contractService.verifyAdditionalCollateral(
            loan.contractLoanId,
            hash,
            loan.wallet.address,
        );
        if (!verification.verified || !verification.amount) {
            throw new ValidationError(verification.error || 'Collateral top-up could not be verified');
        }
        const amount = new PrismaDecimal(verification.amount);

        let updated;
        try {
            [, updated] = await prisma.$transaction([
                prisma.loanTransaction.create({
                    data: {
                        loanId,
                        type: LoanTransactionType.COLLATERAL_TOPUP,
                        amount,
                        txHash: hash,
                        blockNumber: verification.blockNumber,
                        gasUsed: verification.gasUsed ? new PrismaDecimal(verification.gasUsed) : null,
                        confirmed: true,
                        confirmedAt: new Date(),
                    },
                }),
                prisma.loan.update({
                    where: { id: loanId },
                    data: { collateralDeposited: { increment: amount } },
                }),
            ]);
        } catch (err) {
            if (isUniqueViolation(err)) throw new ValidationError('Transaction hash has already been used');
            throw err;
        }

        await prisma.auditLog.create({
            data: {
                userId,
                action: 'COLLATERAL_ADDED',
                entity: 'Loan',
                entityId: loanId,
                metadata: { txHash: hash, amount: amount.toString() },
            },
        });

        return { success: true, loan: updated };
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
        // A payout that landed on-chain but never reached the database shows up
        // as principal already on the pool's books. Record it, don't resend it.
        let disbursementTxHash: string | null = null;
        const alreadyFunded = new PrismaDecimal(await poolService.getLoanPrincipal(loan.contractLoanId));
        if (alreadyFunded.gt(0)) {
            console.warn(`[LoanService] Loan ${loanId} was already funded on-chain; reconciling without a second payout`);
        } else {
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
                note: disbursementTxHash ? null : 'Reconciled from the pool; payout hash not captured',
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
            message: `${disbursementAmount} ETH has been released from the investor pool after withholding the ${loan.originationFee} ETH origination fee. Your repayment is due on ${dueDate.toLocaleDateString()}.`,
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
    ): Promise<{ success: boolean; remainingOwed: string; collateralReleasePending: boolean }> {
        const hash = normalizeTxHash(txHash);

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

        const existingTransaction = await prisma.loanTransaction.findUnique({ where: { txHash: hash } });
        if (existingTransaction) {
            if (existingTransaction.confirmed === false) {
                throw new AppError(409, 'REPAYMENT_IN_PROGRESS', 'This repayment is still being processed. Check again in a minute.');
            }
            throw new ValidationError('Transaction hash has already been used');
        }

        // Verify the actual value transfer. The chain, not the client amount,
        // is authoritative for debt reduction.
        const txInfo = await blockchainService.verifyTransaction(hash);

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
            hash,
            poolAddress,
            loan.contractLoanId,
        );
        if (!credited) {
            throw new ValidationError('The pool did not record a repayment for this loan in that transaction');
        }

        const totalOwed = totalOwedOf(loan);
        const submittedAmount = new PrismaDecimal(amount);
        const repaymentAmount = new PrismaDecimal(txInfo.value);
        if (!repaymentAmount.eq(submittedAmount)) {
            throw new ValidationError(`Submitted amount does not match the on-chain transfer of ${repaymentAmount} ETH`);
        }
        if (repaymentAmount.lte(0)) {
            throw new ValidationError('Repayment amount must be greater than zero');
        }
        if (repaymentAmount.gt(totalOwed)) {
            throw new ValidationError(
                `Repayment of ${repaymentAmount} ETH is more than the ${totalOwed} ETH owed. ` +
                'The pool has received it; contact support to have the difference returned.'
            );
        }

        // Apply payment: fees first, then interest, then principal
        let remaining = repaymentAmount;
        let newFeesOwed = loan.feesOwed;
        let newInterestOwed = loan.interestOwed;
        let newPrincipalOwed = loan.principalOwed;

        if (remaining.gt(0) && newFeesOwed.gt(0)) {
            const feePaid = PrismaDecimal.min(remaining, newFeesOwed);
            newFeesOwed = newFeesOwed.sub(feePaid);
            remaining = remaining.sub(feePaid);
        }

        if (remaining.gt(0) && newInterestOwed.gt(0)) {
            const interestPaid = PrismaDecimal.min(remaining, newInterestOwed);
            newInterestOwed = newInterestOwed.sub(interestPaid);
            remaining = remaining.sub(interestPaid);
        }

        if (remaining.gt(0) && newPrincipalOwed.gt(0)) {
            const principalPaid = PrismaDecimal.min(remaining, newPrincipalOwed);
            newPrincipalOwed = newPrincipalOwed.sub(principalPaid);
        }

        const newTotalOwed = newPrincipalOwed.add(newInterestOwed).add(newFeesOwed);
        const isFullyRepaid = newTotalOwed.lte(0);

        // Claim the hash before any chain write. It is only confirmed once the
        // chain and the balance agree; a failure in between frees it again.
        try {
            await prisma.loanTransaction.create({
                data: {
                    loanId,
                    type: LoanTransactionType.REPAYMENT,
                    amount: repaymentAmount,
                    txHash: hash,
                    blockNumber: txInfo.blockNumber,
                    gasUsed: txInfo.gasUsed ? new PrismaDecimal(txInfo.gasUsed) : null,
                    confirmed: false,
                },
            });
        } catch (err) {
            if (isUniqueViolation(err)) throw new ValidationError('Transaction hash has already been used');
            throw err;
        }

        try {
            await contractService.recordRepayment(loan.contractLoanId, repaymentAmount.toString());
        } catch (err) {
            console.error(`[LoanService] On-chain repayment record failed for loan ${loanId}:`, err);
            await prisma.loanTransaction.delete({ where: { txHash: hash } }).catch((cleanupErr: unknown) => {
                console.error('[LoanService] Could not free the repayment hash:', cleanupErr);
            });
            throw new AppError(
                502,
                'REPAYMENT_NOT_RECORDED',
                'Your payment reached the pool but could not be recorded yet. Your funds are safe — try again in a minute with the same transaction.',
            );
        }

        await prisma.$transaction([
            prisma.loanTransaction.update({
                where: { txHash: hash },
                data: { confirmed: true, confirmedAt: new Date() },
            }),
            prisma.loan.update({
                where: { id: loanId },
                data: {
                    principalOwed: newPrincipalOwed,
                    interestOwed: newInterestOwed,
                    feesOwed: newFeesOwed,
                },
            }),
        ]);

        // A release that fails leaves the loan ACTIVE with nothing owed;
        // completeRepaidLoan finishes it.
        let collateralReleasePending = false;
        if (isFullyRepaid) {
            try {
                await this.releaseAndClose(loan);
            } catch (err) {
                collateralReleasePending = true;
                console.error(`[LoanService] Stake release pending for loan ${loanId}:`, err);
            }
        }

        // What the pool actually credited, taken from its own event rather than
        // recomputed here. Interest is not split with the platform: every ETH of it
        // lifts share value, so it reaches investors directly.
        try {
            await prisma.poolTransaction.create({
                data: {
                    type: 'YIELD_EARNED',
                    amount: new PrismaDecimal(credited.interest),
                    txHash: hash,
                },
            });
            await this._syncPoolMirror();
        } catch (err) {
            // Non-fatal: the repayment itself is already settled on-chain
            console.error('[LoanService] Failed to record pool yield:', err);
        }

        await prisma.auditLog.create({
            data: {
                userId,
                action: isFullyRepaid ? 'LOAN_REPAID' : 'REPAYMENT_RECEIVED',
                entity: 'Loan',
                entityId: loanId,
                metadata: {
                    txHash: hash,
                    amount: repaymentAmount.toString(),
                    isFullyRepaid,
                    collateralReleasePending,
                },
            },
        });

        return {
            success: true,
            remainingOwed: newTotalOwed.toString(),
            collateralReleasePending,
        };
    }

    /** Finish a paid-off loan whose stake release failed earlier. */
    async completeRepaidLoan(loanId: string) {
        const loan = await prisma.loan.findUnique({ where: { id: loanId } });
        if (!loan) throw new NotFoundError('Loan not found');
        if (loan.status === LoanStatus.REPAID) return loan;
        if (loan.status !== LoanStatus.ACTIVE) {
            throw new ValidationError(`Loan is ${loan.status} and cannot be closed`);
        }
        if (totalOwedOf(loan).gt(0)) {
            throw new ValidationError(`${totalOwedOf(loan)} ETH is still owed on this loan`);
        }
        if (loan.contractLoanId === null) {
            throw new ValidationError('Loan has no on-chain identity and requires manual reconciliation');
        }
        await this.releaseAndClose(loan);
        return prisma.loan.findUnique({ where: { id: loanId } });
    }

    private async releaseAndClose(loan: { id: string; userId: string; contractLoanId: number | null; principal: DecimalType }) {
        if (loan.contractLoanId === null) return;
        await contractService.releaseCollateral(loan.contractLoanId);

        await prisma.loan.update({
            where: { id: loan.id },
            data: { status: LoanStatus.REPAID, repaidAt: new Date() },
        });
        await prisma.user.update({
            where: { id: loan.userId },
            data: {
                activeLoansCount: { decrement: 1 },
                completedLoansCount: { increment: 1 },
                totalRepaid: { increment: loan.principal },
            },
        });
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

        const loans = await prisma.loan.findMany({
            where,
            include: {
                wallet: { select: { address: true } },
                plan: { select: { name: true } },
            },
            orderBy: { createdAt: 'desc' },
        });

        // Exact to the wei — clients pay this figure, so they must not add floats
        return loans.map((loan) => ({ ...loan, totalOwed: totalOwedOf(loan).toString() }));
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
     * Cancel an application under review, or an approved loan before collateral.
     */
    async cancelLoan(loanId: string, userId: string): Promise<void> {
        const loan = await prisma.loan.findFirst({
            where: { id: loanId, userId },
        });

        if (!loan) {
            throw new NotFoundError('Loan not found');
        }

        if (loan.status === LoanStatus.PENDING_APPROVAL) {
            if (loan.approvedBy) {
                throw new ValidationError('This application is being reviewed right now and cannot be cancelled');
            }
        } else if (loan.status === LoanStatus.PENDING_COLLATERAL) {
            // Cancel on-chain first, or the borrower could still lock a stake
            // against a loan the database has written off.
            if (loan.contractLoanId !== null) {
                try {
                    await contractService.cancelLoan(loan.contractLoanId);
                } catch (err) {
                    console.error(`[LoanService] On-chain cancel failed for loan ${loanId}:`, err);
                    throw new ValidationError(
                        'The loan could not be cancelled on-chain; collateral may already have been deposited. Refresh and check the loan.'
                    );
                }
            }
        } else {
            throw new ValidationError('Only applications under review or loans awaiting collateral can be cancelled');
        }

        const moved = await prisma.loan.updateMany({
            where: {
                id: loanId,
                status: loan.status,
                ...(loan.status === LoanStatus.PENDING_APPROVAL ? { approvedBy: null } : {}),
            },
            data: { status: LoanStatus.CANCELLED },
        });
        if (moved.count !== 1) {
            throw new ValidationError('The loan changed while cancelling. Refresh and try again.');
        }

        await prisma.auditLog.create({
            data: {
                userId,
                action: 'LOAN_CANCELLED',
                entity: 'Loan',
                entityId: loanId,
                metadata: { from: loan.status },
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
        if (loan.dueDate.getTime() < Date.now()) {
            throw new ValidationError('This loan is past its due date and can no longer be extended');
        }
        if (loan.contractLoanId === null) {
            throw new ValidationError('Loan has no on-chain identity and requires manual reconciliation');
        }

        const extensionFee = toWei(loan.principal.mul(new PrismaDecimal(loan.plan.extensionFee).div(100)));
        const newDueDate = new Date(loan.dueDate.getTime());
        newDueDate.setDate(newDueDate.getDate() + extensionDays);

        // The contract holds the due date liquidation checks and the amount a
        // payoff is measured against, so it moves first.
        try {
            await contractService.extendLoan(loan.contractLoanId, extensionDays * 86400, extensionFee.toString());
        } catch (err) {
            console.error(`[LoanService] On-chain extension failed for loan ${loanId}:`, err);
            throw new ValidationError('The loan could not be extended on-chain. Nothing was changed.');
        }

        await prisma.loan.update({
            where: { id: loanId },
            data: {
                extended: true,
                originalDueDate: loan.dueDate,
                dueDate: newDueDate,
                extensionFee,
                feesOwed: { increment: extensionFee },
                liquidationWarningAt: null,
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

    // ============================================
    // LIQUIDATION
    // ============================================

    /**
     * Seize the stake of an overdue loan and settle the loss with the pool.
     * Only a missed due date counts; the contract re-checks it.
     */
    async liquidateLoan(loanId: string, adminId: string, reason?: string) {
        if (reason && reason !== 'DEFAULT') {
            throw new ValidationError('Only a missed due date can trigger liquidation. Volatility signals are advisory.');
        }

        const loan = await prisma.loan.findUnique({ where: { id: loanId } });
        if (!loan) throw new NotFoundError('Loan not found');
        if (loan.status !== LoanStatus.ACTIVE) {
            throw new ValidationError('Only active loans can be liquidated');
        }
        if (loan.contractLoanId === null) {
            throw new ValidationError('Loan has no on-chain counterpart and cannot be liquidated');
        }
        if (totalOwedOf(loan).lte(0)) {
            throw new ValidationError('This loan is fully paid. Release the stake instead of liquidating it.');
        }
        if (!(await contractService.isLoanOverdue(loan.contractLoanId))) {
            throw new ValidationError('This loan is not overdue on-chain yet');
        }

        const txHash = await contractService.liquidateLoan(loan.contractLoanId, LiquidationReason.Default, 0);

        await prisma.loan.update({
            where: { id: loanId },
            data: { status: LoanStatus.LIQUIDATED, liquidatedAt: new Date() },
        });
        await prisma.user.update({
            where: { id: loan.userId },
            data: { activeLoansCount: { decrement: 1 }, defaultCount: { increment: 1 } },
        });

        const settlement = await this.settlePool(loan, adminId);

        await prisma.auditLog.create({
            data: {
                userId: adminId,
                action: 'LOAN_LIQUIDATED',
                entity: 'Loan',
                entityId: loanId,
                metadata: {
                    borrowerId: loan.userId,
                    principal: loan.principal.toString(),
                    reason: 'DEFAULT',
                    txHash,
                    ...settlement,
                },
            },
        });

        await notificationService.notify(loan.userId, {
            type: 'LOAN_LIQUIDATED',
            title: '⚠️ Loan Liquidated',
            message: 'Your loan passed its due date unpaid, so the stake you locked has been seized.',
            metadata: { loanId, txHash },
        });

        return { txHash, ...settlement };
    }

    /** Retry the pool write-off and recovery after a liquidation. */
    async settleLiquidation(loanId: string, adminId: string) {
        const loan = await prisma.loan.findUnique({ where: { id: loanId } });
        if (!loan) throw new NotFoundError('Loan not found');
        if (loan.status !== LoanStatus.LIQUIDATED) {
            throw new ValidationError('Only liquidated loans can be settled');
        }
        return this.settlePool(loan, adminId);
    }

    /**
     * Both steps are safe to repeat: the write-off only covers what the pool
     * still shows as outstanding, and the recovery is sent once per loan.
     */
    private async settlePool(
        loan: { id: string; contractLoanId: number | null; collateralDeposited: DecimalType },
        adminId: string,
    ) {
        let writeOffTxHash: string | null = null;
        let recoveryTxHash: string | null = null;
        if (!poolService.isConfigured() || loan.contractLoanId === null) {
            return { writeOffTxHash, recoveryTxHash, settlementPending: false };
        }

        try {
            const outstanding = await poolService.getLoanPrincipal(loan.contractLoanId);
            if (new PrismaDecimal(outstanding).gt(0)) {
                writeOffTxHash = await poolService.writeOffLoan(loan.contractLoanId, outstanding);
            }

            const alreadySent = await prisma.auditLog.findFirst({
                where: { action: 'LIQUIDATION_RECOVERY_SENT', entityId: loan.id },
            });
            if (!alreadySent && loan.collateralDeposited.gt(0)) {
                recoveryTxHash = await poolService.recordRecovery(loan.contractLoanId, loan.collateralDeposited.toString());
                await prisma.auditLog.create({
                    data: {
                        userId: adminId,
                        action: 'LIQUIDATION_RECOVERY_SENT',
                        entity: 'Loan',
                        entityId: loan.id,
                        metadata: { txHash: recoveryTxHash, amount: loan.collateralDeposited.toString() },
                    },
                });
            }
            return { writeOffTxHash, recoveryTxHash, settlementPending: false };
        } catch (err) {
            console.error(`[LoanService] Pool settlement pending for loan ${loan.id}:`, err);
            return { writeOffTxHash, recoveryTxHash, settlementPending: true };
        }
    }
}

// Singleton instance
export const loanService = new LoanService();
