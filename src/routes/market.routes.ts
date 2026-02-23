import { Hono } from 'hono';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';

const marketRoutes = new Hono();

/**
 * GET /market/price
 * Get current ETH/PHP price from SystemConfig + latest PriceHistory
 */
marketRoutes.get('/price', async (c) => {
    // Get current rate from SystemConfig (admin-set value)
    const configRate = await prisma.systemConfig.findUnique({
        where: { key: 'ETH_PHP_RATE' },
    });

    // Get latest price history record for metadata
    const latestPrice = await prisma.priceHistory.findFirst({
        orderBy: { createdAt: 'desc' },
    });

    // Get the 24h-ago price for change calculation
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const previousPrice = await prisma.priceHistory.findFirst({
        where: { createdAt: { lte: oneDayAgo } },
        orderBy: { createdAt: 'desc' },
    });

    const currentPrice = configRate ? parseFloat(configRate.value) : env.ETH_PHP_RATE;
    const prevPrice = previousPrice ? Number(previousPrice.ethPricePHP) : currentPrice;
    const change24h = currentPrice - prevPrice;
    const changePercent24h = prevPrice > 0 ? (change24h / prevPrice) * 100 : 0;

    return c.json({
        success: true,
        data: {
            ethPricePHP: currentPrice,
            source: latestPrice?.source ?? 'manual',
            change24h: parseFloat(change24h.toFixed(2)),
            changePercent24h: parseFloat(changePercent24h.toFixed(4)),
            updatedAt: latestPrice?.createdAt ?? new Date().toISOString(),
        },
    });
});

/**
 * GET /market/price/history
 * Get price history with configurable time range
 */
marketRoutes.get('/price/history', async (c) => {
    const rawDays = parseInt(c.req.query('days') || '7', 10);
    const days = Math.min(365, Math.max(1, isNaN(rawDays) ? 7 : rawDays));

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const history = await prisma.priceHistory.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: {
            id: true,
            ethPricePHP: true,
            source: true,
            createdAt: true,
        },
    });

    const data = history.map((h) => ({
        id: h.id,
        ethPricePHP: Number(h.ethPricePHP),
        source: h.source,
        createdAt: h.createdAt,
    }));

    return c.json({
        success: true,
        data,
        meta: {
            days,
            total: data.length,
        },
    });
});

export { marketRoutes };
