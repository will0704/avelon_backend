import cron from 'node-cron';
import { flagOverdueLoans } from './overdue-loans.job.js';

export function startJobs() {
    // Hourly is enough — a due date moves once a day, not once a minute
    cron.schedule('0 0 * * * *', async () => {
        try {
            await flagOverdueLoans();
        } catch (err) {
            console.error('[Jobs] Overdue loan sweep error:', err);
        }
    });

    console.log('[Jobs] Overdue loan sweep scheduled (hourly)');
}
