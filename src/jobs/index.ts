import cron from 'node-cron';
import { flagOverdueLoans } from './overdue-loans.job.js';
import { expireStaleLoans } from './expire-loans.job.js';

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
