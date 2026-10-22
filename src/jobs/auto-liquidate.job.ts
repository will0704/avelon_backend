import { prisma } from '../lib/prisma.js';
import { now, syncClock } from '../lib/clock.js';
import { env } from '../config/env.js';
import { loanService } from '../services/loan.service.js';

const HOUR_MS = 3600_000;
const MAX_BATCH = 20;
let isRunning = false;

/**
 * Liquidate loans that are AUTO_LIQUIDATE_AFTER_HOURS past due. Off unless that
 * variable is set. liquidateLoan re-checks the default on-chain, so a loan the
 * contract doesn't consider overdue is skipped, not forced.
 */
export async function autoLiquidateOverdue(): Promise<number> {
    const hours = env.AUTO_LIQUIDATE_AFTER_HOURS;
    if (hours === undefined || isRunning) return 0;
    isRunning = true;

    try {
        await syncClock();
        const cutoff = new Date(now().getTime() - hours * HOUR_MS);
        const candidates = await prisma.loan.findMany({
            where: { status: 'ACTIVE', dueDate: { lt: cutoff }, contractLoanId: { not: null } },
            select: { id: true, principalOwed: true, interestOwed: true, feesOwed: true },
            take: MAX_BATCH,
            orderBy: { dueDate: 'asc' },
        });

        let liquidated = 0;
        for (const loan of candidates) {
            if (loan.principalOwed.add(loan.interestOwed).add(loan.feesOwed).lte(0)) continue;
            try {
                await loanService.liquidateLoan(loan.id, null);
                liquidated++;
            } catch (err) {
                console.error(`[AutoLiquidate] Skipped ${loan.id}:`, err instanceof Error ? err.message : err);
            }
        }

        if (liquidated > 0) console.log(`[AutoLiquidate] Liquidated ${liquidated} overdue loan(s)`);
        return liquidated;
    } finally {
        isRunning = false;
    }
}
