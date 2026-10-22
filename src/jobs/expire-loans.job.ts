import { prisma } from '../lib/prisma.js';
import { now, syncClock } from '../lib/clock.js';
import { contractService } from '../services/contract.service.js';
import { notificationService } from '../services/notification.service.js';

const DAY_MS = 86400_000;
// An application nobody reviewed, or an approved loan nobody funded, should not
// block the borrower from applying again forever.
const REVIEW_WINDOW_MS = 14 * DAY_MS;
const COLLATERAL_WINDOW_MS = 7 * DAY_MS;
const MAX_BATCH = 50;

let isRunning = false;

export async function expireStaleLoans(): Promise<number> {
    if (isRunning) return 0;
    isRunning = true;
    let expired = 0;

    try {
        await syncClock();
        const unreviewed = await prisma.loan.findMany({
            where: {
                status: 'PENDING_APPROVAL',
                approvedBy: null,
                createdAt: { lt: new Date(now().getTime() - REVIEW_WINDOW_MS) },
            },
            select: { id: true, userId: true, status: true, contractLoanId: true },
            take: MAX_BATCH,
        });

        for (const loan of unreviewed) {
            expired += await expire(loan, { id: loan.id, status: 'PENDING_APPROVAL', approvedBy: null },
                'Your loan application was not reviewed in time and has expired. You can apply again.');
        }

        const unfunded = await prisma.loan.findMany({
            where: {
                status: 'PENDING_COLLATERAL',
                approvedAt: { lt: new Date(now().getTime() - COLLATERAL_WINDOW_MS) },
            },
            select: { id: true, userId: true, status: true, contractLoanId: true },
            take: MAX_BATCH,
        });

        for (const loan of unfunded) {
            // Close it on-chain first so no stake can arrive after it expires
            if (loan.contractLoanId !== null) {
                try {
                    await contractService.cancelLoan(loan.contractLoanId);
                } catch (err) {
                    console.error(`[ExpireLoans] On-chain cancel failed for ${loan.id}; leaving it open:`, err);
                    continue;
                }
            }
            expired += await expire(loan, { id: loan.id, status: 'PENDING_COLLATERAL' },
                'Your approved loan expired because no stake was deposited within 7 days. You can apply again.');
        }
        return expired;
    } finally {
        isRunning = false;
    }
}

async function expire(
    loan: { id: string; userId: string; status: string },
    where: Record<string, unknown>,
    message: string,
): Promise<number> {
    try {
        const moved = await prisma.loan.updateMany({ where, data: { status: 'EXPIRED' } });
        if (moved.count !== 1) return 0;

        await prisma.auditLog.create({
            data: { userId: loan.userId, action: 'LOAN_EXPIRED', entity: 'Loan', entityId: loan.id, metadata: { from: loan.status } },
        });
        await notificationService.notify(loan.userId, {
            type: 'LOAN_CANCELLED',
            title: 'Loan expired',
            message,
            metadata: { loanId: loan.id },
        }, { wait: true });
        return 1;
    } catch (err) {
        console.error(`[ExpireLoans] Failed to expire ${loan.id}:`, err);
        return 0;
    }
}
