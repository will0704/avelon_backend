import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { secureHeaders } from 'hono/secure-headers';
import { timing } from 'hono/timing';

// Import routes
import { authRoutes } from './routes/auth.routes.js';
import { userRoutes } from './routes/user.routes.js';
import { walletRoutes } from './routes/wallet.routes.js';
import { kycRoutes } from './routes/kyc.routes.js';
import { planRoutes } from './routes/plan.routes.js';
import { loanRoutes } from './routes/loan.routes.js';
import { notificationRoutes } from './routes/notification.routes.js';
import { marketRoutes } from './routes/market.routes.js';

// Import admin routes
import { adminRoutes } from './routes/admin/index.js';

// Import middleware
import { errorHandler } from './middleware/error.middleware.js';

// Create Hono app
const app = new Hono();

// =====================================================
// GLOBAL MIDDLEWARE
// =====================================================

// Logging
app.use('*', logger());

// Timing headers
app.use('*', timing());

// Pretty JSON in development
app.use('*', prettyJSON());

// Security headers
app.use('*', secureHeaders());

// CORS
app.use('*', cors({
    origin: (origin) => {
        // Allow all origins in development for mobile testing
        if (process.env.NODE_ENV === 'development') {
            return origin || '*';
        }
        // In production, use whitelist
        const allowedOrigins = [
            'http://localhost:3000',
            'http://localhost:3001',
            'http://localhost:3002',
            'http://localhost:19006',
            'https://avelon.io',
        ];
        return allowedOrigins.includes(origin || '') ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-Request-Id'],
    credentials: true,
    maxAge: 86400,
}));

// Error handler
app.onError(errorHandler);

// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/', (c) => {
    return c.json({
        success: true,
        message: 'Avelon API is running',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
    });
});

app.get('/health', (c) => {
    return c.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

// =====================================================
// API ROUTES (v1)
// =====================================================

const api = new Hono();

// Mount routes
api.route('/auth', authRoutes);
api.route('/users', userRoutes);
api.route('/wallets', walletRoutes);
api.route('/kyc', kycRoutes);
api.route('/plans', planRoutes);
api.route('/loans', loanRoutes);
api.route('/notifications', notificationRoutes);
api.route('/market', marketRoutes);

// Admin routes
api.route('/admin', adminRoutes);

// Mount API under /api/v1
app.route('/api/v1', api);

// =====================================================
// 404 HANDLER
// =====================================================

app.notFound((c) => {
    return c.json({
        success: false,
        error: {
            code: 'NOT_FOUND',
            message: `Route ${c.req.method} ${c.req.path} not found`,
        },
    }, 404);
});

export { app };
