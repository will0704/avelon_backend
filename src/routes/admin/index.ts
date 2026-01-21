import { Hono } from 'hono';

// Import admin sub-routes
import { adminUsersRoutes } from './users.routes.js';
import { adminLoansRoutes } from './loans.routes.js';
import { adminPlansRoutes } from './plans.routes.js';
import { adminKycRoutes } from './kyc.routes.js';
import { adminAnalyticsRoutes } from './analytics.routes.js';

const adminRoutes = new Hono();

// TODO: Add admin auth middleware here
// adminRoutes.use('*', adminAuthMiddleware);

// Mount admin sub-routes
adminRoutes.route('/users', adminUsersRoutes);
adminRoutes.route('/loans', adminLoansRoutes);
adminRoutes.route('/plans', adminPlansRoutes);
adminRoutes.route('/kyc', adminKycRoutes);
adminRoutes.route('/analytics', adminAnalyticsRoutes);

/**
 * GET /admin/treasury
 * Get treasury balance
 */
adminRoutes.get('/treasury', async (c) => {
    // TODO: Implement treasury balance check
    return c.json({
        success: true,
        data: {
            balance: '10.0',
            totalLent: '5.0',
            totalCollected: '5.2',
        },
    });
});

/**
 * POST /admin/price
 * Update ETH/PHP price (demo mode)
 */
adminRoutes.post('/price', async (c) => {
    const { price } = await c.req.json();

    // TODO: Implement price update
    return c.json({
        success: true,
        message: 'Price updated',
        data: {
            ethPricePHP: price,
            updatedAt: new Date().toISOString(),
        },
    });
});

/**
 * GET /admin/audit-logs
 * Get audit logs
 */
adminRoutes.get('/audit-logs', async (c) => {
    // TODO: Implement audit log retrieval
    return c.json({
        success: true,
        data: [],
        meta: {
            total: 0,
            page: 1,
            limit: 50,
        },
    });
});

export { adminRoutes };
