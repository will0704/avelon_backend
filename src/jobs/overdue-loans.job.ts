import { prisma } from '../lib/prisma.js';
import { notificationService } from '../services/notification.service.js';

let isRunning = false;
const MAX_BATCH = 100;

/**
 * Flag ACTIVE loans that are past their due date.
 *
 * This deliberately does not liquidate. Seizing a borrower's stake stays a
 * manual admin action — the job only surfaces the loan and warns the borrower
 * once, via liquidationWarningAt.
 */
export async function flagOverdueLoans(): Promise<void> {
    if (isRunning) return;
    isRunning = true;

    try {
        const overdue = await prisma.loan.findMany({
            where: {
                status: 'ACTIVE',
                dueDate: { lt: new Date() },
                liquidationWarningAt: null,
            },
            take: MAX_BATCH,
            orderBy: { dueDate: 'asc' },
        });

        if (overdue.length === 0) return;

        for (const loan of overdue) {
            try {
                await prisma.loan.update({
                    where: { id: loan.id },
                    data: { liquidationWarningAt: new Date() },
                });

                await notificationService.notify(loan.userId, {
                    type: 'REPAYMENT_OVERDUE',
                    title: 'Payment overdue',
                    message:
                        'Your repayment is past its due date. Settle it to avoid losing the stake you locked for this loan.',
                    metadata: { loanId: loan.id },
                });
            } catch (err) {
                console.error(`[OverdueLoans] Failed to flag loan ${loan.id}:`, err);
            }
        }

        console.log(`[OverdueLoans] Flagged ${overdue.length} overdue loan(s) for admin review`);
    } finally {
        isRunning = false;
    }
}
