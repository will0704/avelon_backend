import { serve } from '@hono/node-server';
import { app } from './app.js';
import { env } from './config/env.js';
import { startJobs } from './jobs/index.js';
import { recoverStalledKyc } from './services/kyc-verification.service.js';

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

    // A restart drops any verification that was in flight, so always sweep once
    recoverStalledKyc().catch((err) => console.error('[KYC] Startup recovery failed:', err));
    setInterval(() => {
        recoverStalledKyc().catch((err) => console.error('[KYC] Stalled verification sweep failed:', err));
    }, 5 * 60 * 1000).unref();

    if (env.ENABLE_BACKGROUND_JOBS) {
        startJobs();
    } else {
        console.log('Background jobs disabled (set ENABLE_BACKGROUND_JOBS=true to opt in)');
    }
});
