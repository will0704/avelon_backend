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
import { NotificationType } from '../../generated/prisma/enums.js';
import { contractService } from '../../services/contract.service.js';
import { env } from '../../config/env.js';
import { poolService } from '../../services/pool.service.js';

const adminRoutes = new Hono();
const volatilityCache = new Map<number, { expiresAt: number; data: Record<string, any> }>();

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

/**
 * GET /admin/blockchain
 * Overview of on-chain state: network, contracts, balances, loan counter
 */
adminRoutes.get('/blockchain', async (c) => {
    try {
        const lendingAddress = process.env.AVELON_LENDING_ADDRESS || null;
        const collateralAddress = process.env.COLLATERAL_MANAGER_ADDRESS || null;
        const scheduleAddress = process.env.REPAYMENT_SCHEDULE_ADDRESS || null;
        const treasuryAddress = process.env.TREASURY_ADDRESS || null;

        // Fetch all on-chain data in parallel
        const [
            networkInfo,
            blockNumber,
            deployerAddress,
            treasuryBalance,
            collateralBalance,
        ] = await Promise.all([
            blockchainService.getNetworkInfo(),
            blockchainService.getBlockNumber(),
            blockchainService.getDeployerAddress(),
            treasuryAddress
                ? blockchainService.getBalance(treasuryAddress)
                : Promise.resolve('0'),
            collateralAddress
                ? blockchainService.getBalance(collateralAddress)
                : Promise.resolve('0'),
        ]);

        // Get deployer balance and on-chain loan count
        const [deployerBalance, currentLoanId] = await Promise.all([
            blockchainService.getBalance(deployerAddress),
            (async () => {
                try {
                    const contract = blockchainService.getAvelonLending();
                    const id = await contract.getCurrentLoanId();
                    return Number(id);
                } catch {
                    return 0;
                }
            })(),
        ]);

        return c.json({
            success: true,
            data: {
                online: true,
                network: networkInfo,
                blockNumber,
                deployer: {
                    address: deployerAddress,
                    balance: deployerBalance,
                },
                contracts: {
                    avelonLending: lendingAddress,
                    collateralManager: collateralAddress,
                    repaymentSchedule: scheduleAddress,
                },
                treasury: {
                    address: treasuryAddress,
                    balance: treasuryBalance,
                },
                collateralPool: {
                    address: collateralAddress,
                    balance: collateralBalance,
                },
                onChainLoanCount: currentLoanId,
            },
        });
    } catch (err) {
        console.error('[admin/blockchain] error:', err);
        return c.json({
            success: true,
            data: {
                online: false,
                network: { name: 'offline', chainId: '0' },
                blockNumber: 0,
                deployer: { address: null, balance: '0' },
                contracts: {
                    avelonLending: process.env.AVELON_LENDING_ADDRESS || null,
                    collateralManager: process.env.COLLATERAL_MANAGER_ADDRESS || null,
                    repaymentSchedule: process.env.REPAYMENT_SCHEDULE_ADDRESS || null,
                },
                treasury: {
                    address: process.env.TREASURY_ADDRESS || null,
                    balance: '0',
                },
                collateralPool: {
                    address: process.env.COLLATERAL_MANAGER_ADDRESS || null,
                    balance: '0',
                },
                onChainLoanCount: 0,
                _warning: 'Blockchain unreachable',
            },
        });
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
        const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
        const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '30', 10)));
        const type = c.req.query('type');
        const unread = c.req.query('unread');
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = {};
        if (type) {
            const matches = Object.values(NotificationType).filter(v => v.startsWith(type));
            where.type = matches.length > 0 ? { in: matches } : type;
        }
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
        const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
        const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
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

/**
 * GET /admin/deposits
 * List all investor deposits across the platform
 */
adminRoutes.get('/deposits', async (c) => {
    try {
        const status = c.req.query('status');
        const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
        const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '30', 10)));
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = {};
        if (status) where.status = status;

        const [deposits, total] = await Promise.all([
            prisma.investorDeposit.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                select: {
                    id: true,
                    userId: true,
                    amount: true,
                    txHash: true,
                    status: true,
                    poolSharePercent: true,
                    createdAt: true,
                    withdrawnAt: true,
                    user: { select: { email: true, name: true } },
                },
            }),
            prisma.investorDeposit.count({ where }),
        ]);

        return c.json({
            success: true,
            data: deposits.map((d) => ({ ...d, amount: Number(d.amount) })),
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (err) {
        console.error('[admin/deposits] error:', err);
        return c.json({ success: false, message: 'Failed to fetch deposits' }, 500);
    }
});

/**
 * GET /admin/pool
 * Liquidity pool state and metrics
 */
adminRoutes.get('/pool', async (c) => {
    try {
        const pool = await prisma.liquidityPool.findFirst();

        // Read the pool contract rather than the mirror row. The mirror only
        // refreshes on investor activity, so between events it under-reports.
        if (poolService.isConfigured()) {
            const [state, investors] = await Promise.all([
                poolService.getPoolState(),
                prisma.investorDeposit.groupBy({ by: ['userId'], where: { status: 'CONFIRMED' }, _count: true }),
            ]);

            return c.json({
                success: true,
                data: {
                    poolAddress: state.address,
                    totalLiquidity: Number(state.totalAssets),
                    availableLiquidity: Number(state.availableLiquidity),
                    totalBorrowed: Number(state.totalOutstandingPrincipal),
                    totalShares: Number(state.totalShares),
                    cumulativeYield: Number(state.cumulativeInterest),
                    cumulativeWriteOffs: Number(state.cumulativeWriteOffs),
                    utilizationRate: state.utilization,
                    // Interest received to date over pool size. Backward-looking, not a promise.
                    apy: Number(state.totalAssets) > 0
                        ? Number(state.cumulativeInterest) / Number(state.totalAssets)
                        : 0,
                    investorCount: investors.length,
                    source: 'chain' as const,
                    lastUpdated: new Date(),
                },
            });
        }

        return c.json({
            success: true,
            data: {
                poolAddress: null,
                totalLiquidity: Number(pool?.totalLiquidity ?? 0),
                availableLiquidity: 0,
                totalBorrowed: Number(pool?.totalBorrowed ?? 0),
                totalShares: 0,
                cumulativeYield: Number(pool?.cumulativeYield ?? 0),
                cumulativeWriteOffs: 0,
                utilizationRate: pool?.utilizationRate ?? 0,
                apy: pool?.apy ?? 0,
                investorCount: 0,
                source: 'database' as const,
                lastUpdated: pool?.lastUpdated ?? new Date(),
            },
        });
    } catch (err) {
        console.error('[admin/pool] error:', err);
        return c.json({ success: false, message: 'Failed to fetch pool data' }, 500);
    }
});

/**
 * GET /admin/volatility
 * ETH volatility research forecast. ETH price does not change an ETH/ETH debt
 * ratio, so this endpoint is advisory and never drives liquidation.
 */
adminRoutes.get('/volatility', async (c) => {
    const horizonDays = Math.min(30, Math.max(1, Number(c.req.query('horizon') ?? 7)));

    try {
        const cached = volatilityCache.get(horizonDays);
        let baseline = cached && cached.expiresAt > Date.now() ? cached.data : null;
        if (!baseline) {
            const url = new URL(`${env.AI_SERVICE_URL}/api/v1/predict/volatility`);
            url.searchParams.set('horizon_days', String(horizonDays));

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            try {
                const res = await fetch(url, {
                    headers: { 'X-API-Key': env.AI_API_KEY },
                    signal: controller.signal,
                });
                if (!res.ok) throw new Error(`AI service returned ${res.status}`);
                baseline = await res.json() as Record<string, any>;
                volatilityCache.set(horizonDays, {
                    expiresAt: Date.now() + 15 * 60 * 1000,
                    data: baseline,
                });
            } finally {
                clearTimeout(timeout);
            }
        }

        return c.json({
            success: true,
            data: {
                online: true,
                horizonDays,
                advisoryOnly: true,
                liquidationEnabled: false,
                economicNote: 'ETH volatility does not change an ETH-collateral/ETH-debt ratio; liquidation is based only on an overdue default.',
                currentPricePHP: baseline.current_price_php,
                priceSource: baseline.price_source,
                model: baseline.model,
                predictedVolatility: baseline.predicted_volatility,
                realizedVolatility24h: baseline.realized_volatility_24h,
                horizonVolatility: baseline.horizon_volatility,
                riskLevel: baseline.risk_level,
                priceRange68: baseline.price_range_68,
                priceRange95: baseline.price_range_95,
                recentPrices: baseline.recent_prices,
                modelMetadata: baseline.model_metadata,
            },
        });
    } catch (err) {
        console.error('[admin/volatility] error:', err);
        // The AI service being down must not blank the page — the UI shows a banner.
        return c.json({
            success: true,
            data: { online: false, horizonDays, advisoryOnly: true, liquidationEnabled: false },
        });
    }
});

export { adminRoutes };
