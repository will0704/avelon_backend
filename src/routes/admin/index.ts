import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

// Import admin sub-routes
import { adminUsersRoutes } from './users.routes.js';
import { adminLoansRoutes } from './loans.routes.js';
import { adminPlansRoutes } from './plans.routes.js';
import { adminKycRoutes } from './kyc.routes.js';
import { adminAnalyticsRoutes } from './analytics.routes.js';

// Import middleware
import { authMiddleware, adminMiddleware } from '../../middleware/auth.middleware.js';

const adminRoutes = new Hono();

// Protect ALL admin routes with auth + admin role check (OWASP A01)
adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', adminMiddleware);

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

// Validation schema for price update (OWASP A03)
const updatePriceSchema = z.object({
    price: z.number().positive('Price must be a positive number').max(100_000_000, 'Price exceeds maximum'),
});

/**
 * POST /admin/price
 * Update ETH/PHP price (demo mode)
 */
adminRoutes.post('/price', zValidator('json', updatePriceSchema), async (c) => {
    const { price } = c.req.valid('json');

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
