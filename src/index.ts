import { serve } from '@hono/node-server';
import { app } from './app.js';
import { env } from './config/env.js';

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
});
