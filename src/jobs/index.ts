import cron from 'node-cron';
import { pollPendingDeposits } from './deposit-poller.job.js';

export function startJobs() {
    // Poll pending investor deposits every 60 seconds
    cron.schedule('*/60 * * * * *', async () => {
        try {
            await pollPendingDeposits();
        } catch (err) {
            console.error('[Jobs] Deposit poller error:', err);
        }
    });

    console.log('[Jobs] Deposit poller scheduled (every 60s)');
}
