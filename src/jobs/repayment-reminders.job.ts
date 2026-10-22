import { prisma } from '../lib/prisma.js';
import { now, syncClock } from '../lib/clock.js';
import { env } from '../config/env.js';
import { notificationService } from '../services/notification.service.js';
import { ethText } from '../lib/eth-text.js';

const DAY_MS = 86400_000;
const MAX_BATCH = 100;
let isRunning = false;

/** One reminder per loan, REMINDER_DAYS_BEFORE days ahead of the due date. */
export async function sendRepaymentReminders(): Promise<number> {
    if (isRunning) return 0;
    isRunning = true;

    try {
        await syncClock();
        const current = now();
        const horizon = new Date(current.getTime() + env.REMINDER_DAYS_BEFORE * DAY_MS);

        const due = await prisma.loan.findMany({
            where: {
                status: 'ACTIVE',
                reminderSentAt: null,
                dueDate: { gt: current, lte: horizon },
            },
            take: MAX_BATCH,
            orderBy: { dueDate: 'asc' },
        });

        let sent = 0;
        for (const loan of due) {
            const amountDue = loan.principalOwed.add(loan.interestOwed).add(loan.feesOwed);
            if (amountDue.lte(0) || !loan.dueDate) continue;

            // Claim it first so two overlapping runs can't both send
            const claimed = await prisma.loan.updateMany({
                where: { id: loan.id, reminderSentAt: null },
                data: { reminderSentAt: current },
            });
            if (claimed.count !== 1) continue;

            const daysLeft = Math.max(1, Math.ceil((loan.dueDate.getTime() - current.getTime()) / DAY_MS));
            await notificationService.notify(loan.userId, {
                type: 'REPAYMENT_REMINDER',
                title: 'Repayment due soon',
                message: `Repay ${ethText(amountDue)} ETH by ${loan.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left) to get your stake back.`,
                metadata: { loanId: loan.id, amountDue: amountDue.toString(), dueDate: loan.dueDate.toISOString() },
            }, { wait: true });
            sent++;
        }

        if (sent > 0) console.log(`[Reminders] Sent ${sent} repayment reminder(s)`);
        return sent;
    } finally {
        isRunning = false;
    }
}
