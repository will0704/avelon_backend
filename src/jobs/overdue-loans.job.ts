import { prisma } from '../lib/prisma.js';
import { now, syncClock } from '../lib/clock.js';
import { env } from '../config/env.js';
import { notificationService } from '../services/notification.service.js';
import { ethText } from '../lib/eth-text.js';

let isRunning = false;
const MAX_BATCH = 100;
const HOUR_MS = 3600_000;

/**
 * Flag ACTIVE loans that are past their due date.
 *
 * This does not liquidate. Seizing a stake is an admin action unless
 * AUTO_LIQUIDATE_AFTER_HOURS is set, in which case auto-liquidate.job does it
 * later. The borrower is warned once, via liquidationWarningAt.
 */
export async function flagOverdueLoans(): Promise<number> {
    if (isRunning) return 0;
    isRunning = true;

    try {
        await syncClock();
        const overdue = await prisma.loan.findMany({
            where: {
                status: 'ACTIVE',
                dueDate: { lt: now() },
                liquidationWarningAt: null,
            },
            take: MAX_BATCH,
            orderBy: { dueDate: 'asc' },
        });

        // A paid-off loan waiting for its stake to be released is not overdue
        const owing = overdue.filter((loan) =>
            loan.principalOwed.add(loan.interestOwed).add(loan.feesOwed).gt(0));
        if (owing.length === 0) return 0;

        const autoHours = env.AUTO_LIQUIDATE_AFTER_HOURS;
        for (const loan of owing) {
            try {
                await prisma.loan.update({
                    where: { id: loan.id },
                    data: { liquidationWarningAt: now() },
                });

                const amountDue = loan.principalOwed.add(loan.interestOwed).add(loan.feesOwed).toString();
                const liquidatesAt = autoHours !== undefined && loan.dueDate
                    ? new Date(loan.dueDate.getTime() + autoHours * HOUR_MS).toISOString()
                    : undefined;

                await notificationService.notify(loan.userId, {
                    type: 'REPAYMENT_OVERDUE',
                    title: 'Payment overdue',
                    message: liquidatesAt
                        ? `Your repayment of ${ethText(amountDue)} ETH is past its due date. Repay before ${new Date(liquidatesAt).toLocaleString('en-US')} or the stake you locked will be seized.`
                        : `Your repayment of ${ethText(amountDue)} ETH is past its due date. Repay now to avoid losing the stake you locked for this loan.`,
                    metadata: { loanId: loan.id, amountDue, dueDate: loan.dueDate?.toISOString(), liquidatesAt },
                }, { wait: true });
            } catch (err) {
                console.error(`[OverdueLoans] Failed to flag loan ${loan.id}:`, err);
            }
        }

        console.log(`[OverdueLoans] Flagged ${owing.length} overdue loan(s) for admin review`);
        return owing.length;
    } finally {
        isRunning = false;
    }
}
