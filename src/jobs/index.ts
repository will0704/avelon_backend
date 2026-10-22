import cron from 'node-cron';
import { flagOverdueLoans } from './overdue-loans.job.js';
import { expireStaleLoans } from './expire-loans.job.js';
import { syncEthPhpPrices } from './price-feed.job.js';
import { sendRepaymentReminders } from './repayment-reminders.job.js';
import { runRiskMonitor } from './risk-monitor.job.js';
import { autoLiquidateOverdue } from './auto-liquidate.job.js';

// Each returns how many loans it acted on. The admin demo controls run them on demand.
export const JOBS = {
    reminders: sendRepaymentReminders,
    overdue: flagOverdueLoans,
    'auto-liquidate': autoLiquidateOverdue,
    expiry: expireStaleLoans,
    'risk-monitor': runRiskMonitor,
} as const;

export type JobName = keyof typeof JOBS;

/** Run every loan job once, in lifecycle order. */
export async function runAllJobs(): Promise<Record<JobName, number>> {
    const results = {} as Record<JobName, number>;
    for (const [name, job] of Object.entries(JOBS) as [JobName, () => Promise<number>][]) {
        try {
            results[name] = await job();
        } catch (err) {
            console.error(`[Jobs] ${name} failed:`, err);
            results[name] = -1;
        }
    }
    return results;
}

function hourly(minute: number, name: JobName) {
    cron.schedule(`0 ${minute} * * * *`, async () => {
        try {
            await JOBS[name]();
        } catch (err) {
            console.error(`[Jobs] ${name} sweep error:`, err);
        }
    });
}

export function startJobs() {
    // Hourly is enough — a due date moves once a day, not once a minute
    hourly(0, 'overdue');
    hourly(10, 'reminders');
    hourly(20, 'risk-monitor');
    hourly(30, 'expiry');
    hourly(40, 'auto-liquidate');

    console.log('[Jobs] Overdue, reminder, risk, expiry and auto-liquidation sweeps scheduled');
}

// Separate from startJobs: it only reads a public price API, and every price chart
// is empty without it. Gated by PRICE_FEED_ENABLED instead.
export function startPriceFeed() {
    const run = async (skipIfFresh: boolean) => {
        try {
            const result = await syncEthPhpPrices({ skipIfFresh });
            if (result && (result.added > 0 || result.price !== null)) {
                console.log(`[PriceFeed] Stored ${result.added} hourly price(s); ETH/PHP is ${result.price ?? 'unchanged'}`);
            }
        } catch (err) {
            console.warn('[PriceFeed] Sync failed:', err instanceof Error ? err.message : err);
        }
    };

    // On boot, catch up on whatever was missed while the server was down or asleep
    void run(true);
    // Five past the hour, once CoinGecko has closed the bar
    cron.schedule('0 5 * * * *', () => run(false));

    console.log('[PriceFeed] ETH/PHP prices update hourly from CoinGecko');
}
