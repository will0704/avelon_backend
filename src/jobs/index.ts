import cron from 'node-cron';
import { pollPendingDeposits } from './deposit-poller.job.js';
import { flagOverdueLoans } from './overdue-loans.job.js';

export function startJobs() {
    // Poll pending investor deposits every 60 seconds
    cron.schedule('*/60 * * * * *', async () => {
        try {
            await pollPendingDeposits();
        } catch (err) {
            console.error('[Jobs] Deposit poller error:', err);
        }
    });

    // Hourly is enough — a due date moves once a day, not once a minute
    cron.schedule('0 0 * * * *', async () => {
        try {
            await flagOverdueLoans();
        } catch (err) {
            console.error('[Jobs] Overdue loan sweep error:', err);
        }
    });

    console.log('[Jobs] Deposit poller scheduled (every 60s), overdue loan sweep (hourly)');
}
