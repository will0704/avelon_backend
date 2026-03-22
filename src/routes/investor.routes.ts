import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { investorMiddleware } from '../middleware/auth.middleware.js';
import { investorService } from '../services/investor.service.js';

const investorRoutes = new Hono();

// All investor routes require auth + investor role
investorRoutes.use('*', authMiddleware, investorMiddleware);

// =====================================================
// ROUTES
// =====================================================

/**
 * GET /investor/dashboard
 * Investor dashboard: totals, pool stats, recent transactions
 */
investorRoutes.get('/dashboard', async (c) => {
    const userId = c.get('userId');
    const data = await investorService.getDashboard(userId);
    return c.json({ success: true, data });
});

/**
 * GET /investor/pool
 * Public pool stats (still requires investor auth here)
 */
investorRoutes.get('/pool', async (c) => {
    const data = await investorService.getPoolStats();
    return c.json({ success: true, data });
});

/**
 * GET /investor/earnings
 * Yield earnings breakdown
 */
investorRoutes.get('/earnings', async (c) => {
    const userId = c.get('userId');
    const data = await investorService.getEarnings(userId);
    return c.json({ success: true, data });
});

/**
 * GET /investor/transactions
 * Paginated pool transaction history
 */
investorRoutes.get('/transactions', async (c) => {
    const userId = c.get('userId');
    const page = Number(c.req.query('page') ?? '1');
    const limit = Math.min(Number(c.req.query('limit') ?? '20'), 100);
    const data = await investorService.getTransactions(userId, page, limit);
    return c.json({ success: true, data });
});

/**
 * GET /investor/deposits
 * List investor's own deposits
 */
investorRoutes.get('/deposits', async (c) => {
    const userId = c.get('userId');
    const status = c.req.query('status');
    const deposits = await investorService.getDeposits(userId, status);
    return c.json({ success: true, data: deposits });
});

/**
 * POST /investor/deposit
 * Record a new deposit (after on-chain tx submitted)
 */
investorRoutes.post(
    '/deposit',
    zValidator(
        'json',
        z.object({
            txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid transaction hash'),
            amount: z.string().regex(/^\d+(\.\d+)?$/, 'Invalid amount'),
        }),
    ),
    async (c) => {
        const userId = c.get('userId');
        const { txHash, amount } = c.req.valid('json');
        const deposit = await investorService.recordDeposit(userId, txHash, amount);
        return c.json({ success: true, data: deposit }, 201);
    },
);

/**
 * POST /investor/deposit/:txHash/confirm
 * Confirm deposit after on-chain confirmation received
 */
investorRoutes.post('/deposit/:txHash/confirm', async (c) => {
    const userId = c.get('userId');
    const txHash = c.req.param('txHash');
    const deposit = await investorService.confirmDeposit(userId, txHash);
    return c.json({ success: true, data: deposit });
});

/**
 * POST /investor/withdraw/:depositId
 * Withdraw a confirmed deposit from the pool
 */
investorRoutes.post('/withdraw/:depositId', async (c) => {
    const userId = c.get('userId');
    const depositId = c.req.param('depositId');
    const deposit = await investorService.withdraw(userId, depositId);
    return c.json({ success: true, data: deposit });
});

export { investorRoutes };
