import { Hono } from 'hono';
import { env } from '../config/env.js';

const marketRoutes = new Hono();

/**
 * GET /market/price
 * Get current ETH/PHP price
 */
marketRoutes.get('/price', async (c) => {
    // TODO: Implement price fetching from oracle or cache
    return c.json({
        success: true,
        data: {
            ethPricePHP: env.ETH_PHP_RATE,
            source: 'manual',
            updatedAt: new Date().toISOString(),
        },
    });
});

/**
 * GET /market/price/history
 * Get price history
 */
marketRoutes.get('/price/history', async (c) => {
    const rawDays = parseInt(c.req.query('days') || '7', 10);
    const days = Math.min(365, Math.max(1, isNaN(rawDays) ? 7 : rawDays));

    // TODO: Implement price history
    return c.json({
        success: true,
        data: [],
    });
});

export { marketRoutes };
