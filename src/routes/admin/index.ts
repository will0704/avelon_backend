import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

// Import admin sub-routes
import { adminUsersRoutes } from './users.routes.js';
import { adminLoansRoutes } from './loans.routes.js';
import { adminPlansRoutes } from './plans.routes.js';
import { adminKycRoutes } from './kyc.routes.js';
import { adminAnalyticsRoutes } from './analytics.routes.js';

// Import middleware & db
import { authMiddleware, adminMiddleware } from '../../middleware/auth.middleware.js';
import { prisma } from '../../lib/prisma.js';
import { blockchainService } from '../../services/blockchain.service.js';

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
 * GET /admin/transactions
 * List all loan transactions across the platform
 */
adminRoutes.get('/transactions', async (c) => {
    try {
        const type = c.req.query('type');
        const where: Record<string, unknown> = {};
        if (type) {
            where.type = type;
        }

        const transactions = await prisma.loanTransaction.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: 200,
            select: {
                id: true,
                loanId: true,
                type: true,
                amount: true,
                amountPHP: true,
                ethPrice: true,
                txHash: true,
                blockNumber: true,
                confirmed: true,
                confirmedAt: true,
                note: true,
                createdAt: true,
            },
        });

        // Map to frontend LoanTransaction shape
        const mapped = transactions.map((tx) => ({
            id: tx.id,
            loanId: tx.loanId,
            type: tx.type,
            amount: Number(tx.amount),
            status: tx.confirmed ? 'CONFIRMED' : 'PENDING',
            transactionHash: tx.txHash,
            blockNumber: tx.blockNumber,
            fromAddress: null,
            toAddress: null,
            description: tx.note,
            createdAt: tx.createdAt,
            confirmedAt: tx.confirmedAt,
        }));

        return c.json({
            success: true,
            data: { transactions: mapped },
        });
    } catch (err) {
        console.error('[admin/transactions] list error:', err);
        return c.json({ success: false, message: 'Failed to fetch transactions' }, 500);
    }
});

/**
 * GET /admin/treasury
 * Get treasury balance from Sepolia blockchain + DB aggregates
 */
adminRoutes.get('/treasury', async (c) => {
    try {
        const treasuryAddress = process.env.TREASURY_ADDRESS;
        const collateralManagerAddress = process.env.COLLATERAL_MANAGER_ADDRESS;

        // Fetch on-chain and DB data in parallel
        const [
            treasuryBalance,
            collateralBalance,
            loanAggregates,
            repaidAggregates,
            networkInfo,
        ] = await Promise.all([
            // Treasury wallet ETH balance on Sepolia
            treasuryAddress
                ? blockchainService.getBalance(treasuryAddress)
                : Promise.resolve('0'),
            // CollateralManager contract ETH balance (total locked collateral)
            collateralManagerAddress
                ? blockchainService.getBalance(collateralManagerAddress)
                : Promise.resolve('0'),
            // Total principal lent out (sum of all loan principals)
            prisma.loan.aggregate({
                _sum: { principal: true, originationFee: true },
                where: { status: { in: ['ACTIVE', 'REPAID', 'LIQUIDATED'] } },
            }),
            // Total collected (repaid loans principal + interest + fees)
            prisma.loan.aggregate({
                _sum: { principal: true, interestOwed: true, feesOwed: true },
                where: { status: 'REPAID' },
            }),
            // Network info for display
            blockchainService.getNetworkInfo().catch(() => ({ name: 'unknown', chainId: '0' })),
        ]);

        const totalLent = loanAggregates._sum.principal?.toString() || '0';
        const totalFees = loanAggregates._sum.originationFee?.toString() || '0';
        const totalRepaidPrincipal = repaidAggregates._sum.principal?.toString() || '0';
        const totalInterestCollected = repaidAggregates._sum.interestOwed?.toString() || '0';
        const totalFeesCollected = repaidAggregates._sum.feesOwed?.toString() || '0';

        const totalCollected = (
            parseFloat(totalRepaidPrincipal) +
            parseFloat(totalInterestCollected) +
            parseFloat(totalFeesCollected)
        ).toString();

        // Active loan count
        const activeLoansCount = await prisma.loan.count({ where: { status: 'ACTIVE' } });

        return c.json({
            success: true,
            data: {
                balance: treasuryBalance,
                totalLent,
                totalCollected,
                totalFees,
                totalInterestCollected,
                collateralLocked: collateralBalance,
                activeLoansCount,
                treasuryAddress: treasuryAddress || null,
                collateralManagerAddress: collateralManagerAddress || null,
                network: networkInfo,
            },
        });
    } catch (err) {
        console.error('[admin/treasury] error:', err);
        // Fallback to DB-only data if blockchain is unreachable
        try {
            const loanAggregates = await prisma.loan.aggregate({
                _sum: { principal: true, originationFee: true },
                where: { status: { in: ['ACTIVE', 'REPAID', 'LIQUIDATED'] } },
            });
            const repaidAggregates = await prisma.loan.aggregate({
                _sum: { principal: true, interestOwed: true, feesOwed: true },
                where: { status: 'REPAID' },
            });

            return c.json({
                success: true,
                data: {
                    balance: '0',
                    totalLent: loanAggregates._sum.principal?.toString() || '0',
                    totalCollected: (
                        parseFloat(repaidAggregates._sum.principal?.toString() || '0') +
                        parseFloat(repaidAggregates._sum.interestOwed?.toString() || '0') +
                        parseFloat(repaidAggregates._sum.feesOwed?.toString() || '0')
                    ).toString(),
                    totalFees: loanAggregates._sum.originationFee?.toString() || '0',
                    collateralLocked: '0',
                    activeLoansCount: 0,
                    treasuryAddress: process.env.TREASURY_ADDRESS || null,
                    network: { name: 'offline', chainId: '0' },
                    _warning: 'Blockchain unreachable — showing DB-only data',
                },
            });
        } catch {
            return c.json({ success: false, message: 'Failed to fetch treasury data' }, 500);
        }
    }
});

// Validation schema for price update (OWASP A03)
const updatePriceSchema = z.object({
    price: z.number().positive('Price must be a positive number').max(100_000_000, 'Price exceeds maximum'),
});

/**
 * POST /admin/price
 * Update ETH/PHP price — writes to SystemConfig + PriceHistory
 */
adminRoutes.post('/price', zValidator('json', updatePriceSchema), async (c) => {
    try {
        const { price } = c.req.valid('json');
        const adminId = (c.get('userId' as never) as string) ?? 'system';

        // Upsert SystemConfig ETH_PHP_RATE
        await prisma.systemConfig.upsert({
            where: { key: 'ETH_PHP_RATE' },
            update: {
                value: price.toString(),
                updatedBy: adminId,
            },
            create: {
                key: 'ETH_PHP_RATE',
                value: price.toString(),
                description: 'ETH/PHP exchange rate',
                updatedBy: adminId,
            },
        });

        // Record in PriceHistory
        await prisma.priceHistory.create({
            data: {
                ethPricePHP: price,
                source: 'manual',
            },
        });

        return c.json({
            success: true,
            message: 'Price updated',
            data: {
                ethPricePHP: price,
                updatedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        console.error('[admin/price] update error:', err);
        return c.json({ success: false, message: 'Failed to update price' }, 500);
    }
});

/**
 * GET /admin/notifications
 * List all notifications across all users with pagination and filters
 * Query params: page, limit, type, unread
 */
adminRoutes.get('/notifications', async (c) => {
    try {
        const page = parseInt(c.req.query('page') || '1');
        const limit = parseInt(c.req.query('limit') || '30');
        const type = c.req.query('type');
        const unread = c.req.query('unread');
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = {};
        if (type) where.type = type;
        if (unread === 'true') where.isRead = false;
        if (unread === 'false') where.isRead = true;

        const [notifications, total] = await Promise.all([
            prisma.notification.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                select: {
                    id: true,
                    userId: true,
                    type: true,
                    title: true,
                    message: true,
                    isRead: true,
                    readAt: true,
                    createdAt: true,
                    user: { select: { email: true, name: true } },
                },
            }),
            prisma.notification.count({ where }),
        ]);

        return c.json({
            success: true,
            data: notifications,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (err) {
        console.error('[admin/notifications] error:', err);
        return c.json({ success: false, message: 'Failed to fetch notifications' }, 500);
    }
});

/**
 * GET /admin/audit-logs
 * Get audit logs with pagination and optional filters
 * Query params: page, limit, action, entity, search (user email)
 */
adminRoutes.get('/audit-logs', async (c) => {
    try {
        const page = parseInt(c.req.query('page') || '1');
        const limit = parseInt(c.req.query('limit') || '50');
        const action = c.req.query('action');
        const entity = c.req.query('entity');
        const search = c.req.query('search');
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = {};
        if (action) where.action = { contains: action, mode: 'insensitive' };
        if (entity) where.entity = { contains: entity, mode: 'insensitive' };
        if (search) where.user = { email: { contains: search, mode: 'insensitive' } };

        const [logs, total] = await Promise.all([
            prisma.auditLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                select: {
                    id: true,
                    userId: true,
                    action: true,
                    entity: true,
                    entityId: true,
                    ipAddress: true,
                    metadata: true,
                    createdAt: true,
                    user: { select: { email: true, name: true } },
                },
            }),
            prisma.auditLog.count({ where }),
        ]);

        return c.json({
            success: true,
            data: logs,
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (err) {
        console.error('[admin/audit-logs] error:', err);
        return c.json({ success: false, message: 'Failed to fetch audit logs' }, 500);
    }
});

export { adminRoutes };
