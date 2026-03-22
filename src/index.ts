import { serve } from '@hono/node-server';
import { app } from './app.js';
import { env } from './config/env.js';
import { startJobs } from './jobs/index.js';

const port = env.PORT;

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║     █████╗ ██╗   ██╗███████╗██╗      ██████╗ ███╗   ██╗      ║
║    ██╔══██╗██║   ██║██╔════╝██║     ██╔═══██╗████╗  ██║      ║
║    ███████║██║   ██║█████╗  ██║     ██║   ██║██╔██╗ ██║      ║
║    ██╔══██║╚██╗ ██╔╝██╔══╝  ██║     ██║   ██║██║╚██╗██║      ║
║    ██║  ██║ ╚████╔╝ ███████╗███████╗╚██████╔╝██║ ╚████║      ║
║    ╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝      ║
║                                                               ║
║              Blockchain-Based Crypto Lending Platform         ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`);

console.log(`Server starting on port ${port}...`);
console.log(`Environment: ${env.NODE_ENV}`);

serve({
    fetch: app.fetch,
    port,
}, (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
    console.log(`API Documentation: http://localhost:${info.port}/api/v1`);

    // ─── Render.com keep-alive ────────────────────────────────────────────────
    // Render free tier spins down services after 15 minutes of inactivity.
    // Ping our own /health endpoint every 14 minutes to prevent cold starts.
    if (env.NODE_ENV === 'production') {
        const KEEP_ALIVE_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes
        const selfUrl = `http://localhost:${info.port}/health`;

        setInterval(async () => {
            try {
                await fetch(selfUrl);
            } catch {
                // Non-fatal — server is still running if this fails
            }
        }, KEEP_ALIVE_INTERVAL_MS);

        console.log('Keep-alive ping scheduled every 14 minutes (Render.com)');
    }

    // Start background jobs (deposit poller, etc.)
    startJobs();
});
