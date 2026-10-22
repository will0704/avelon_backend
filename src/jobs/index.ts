import cron from 'node-cron';
import { flagOverdueLoans } from './overdue-loans.job.js';
import { expireStaleLoans } from './expire-loans.job.js';
import { syncEthPhpPrices } from './price-feed.job.js';

export function startJobs() {
    // Hourly is enough — a due date moves once a day, not once a minute
    cron.schedule('0 0 * * * *', async () => {
        try {
            await flagOverdueLoans();
        } catch (err) {
            console.error('[Jobs] Overdue loan sweep error:', err);
        }
    });

    cron.schedule('0 30 * * * *', async () => {
        try {
            await expireStaleLoans();
        } catch (err) {
            console.error('[Jobs] Loan expiry sweep error:', err);
        }
    });

    console.log('[Jobs] Overdue and expiry sweeps scheduled');
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
