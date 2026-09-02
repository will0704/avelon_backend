import { Hono, type Context } from 'hono';
import { authMiddleware, investorMiddleware, verifiedMiddleware } from '../middleware/auth.middleware.js';
import { investorService } from '../services/investor.service.js';
import { ValidationError } from '../middleware/error.middleware.js';

const investorRoutes = new Hono();

// All investor routes require auth + investor role
investorRoutes.use('*', authMiddleware, investorMiddleware);

/** Read a transaction hash out of the body and reject anything malformed early. */
const readTxHash = async (c: Context) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const txHash = (body as { txHash?: unknown }).txHash;
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        throw new ValidationError('txHash is required and must be a 32-byte hex hash');
    }
    return txHash;
};

// =====================================================
// READS
// =====================================================

/**
 * GET /investor/dashboard
 * Live position read from the pool contract, plus pool stats and recent activity
 */
investorRoutes.get('/dashboard', async (c) => {
    const userId = c.get('userId');
    const data = await investorService.getDashboard(userId);
    return c.json({ success: true, data });
});

/**
 * GET /investor/pool
 * Pool-wide stats
 */
investorRoutes.get('/pool', async (c) => {
    const data = await investorService.getPoolStats();
    return c.json({ success: true, data });
});

/**
 * GET /investor/position
 * Just this investor's position
 */
investorRoutes.get('/position', async (c) => {
    const userId = c.get('userId');
    const data = await investorService.getPosition(userId);
    return c.json({ success: true, data });
});

/**
 * GET /investor/earnings
 * Yield breakdown, realised and unrealised
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
 * GET /investor/calldata
 * The exact transaction the investor's wallet has to sign. Keeps the pool's
 * function selectors out of the clients.
 */
investorRoutes.get('/calldata', async (c) => {
    const action = c.req.query('action');
    if (action !== 'deposit' && action !== 'withdraw' && action !== 'claim') {
        throw new ValidationError('action must be one of: deposit, withdraw, claim');
    }
    const data = await investorService.getCallData(action, c.req.query('shares'));
    return c.json({ success: true, data });
});

// =====================================================
// WRITES — all of these file a transaction the investor already signed.
// The backend never holds an investor key and never moves investor funds.
// =====================================================

/**
 * POST /investor/deposit
 * Record a deposit the investor signed. Amount and shares come from the pool's
 * own event, not from the request body.
 */
investorRoutes.post('/deposit', verifiedMiddleware, async (c) => {
    const userId = c.get('userId');
    const txHash = await readTxHash(c);
    const data = await investorService.recordDeposit(userId, txHash);
    return c.json({ success: true, data });
});

/**
 * POST /investor/withdraw
 * Record a withdrawal the investor signed
 */
investorRoutes.post('/withdraw', verifiedMiddleware, async (c) => {
    const userId = c.get('userId');
    const txHash = await readTxHash(c);
    const data = await investorService.recordWithdrawal(userId, txHash);
    return c.json({ success: true, data });
});

/**
 * POST /investor/claim-yield
 * Record a yield claim the investor signed
 */
investorRoutes.post('/claim-yield', verifiedMiddleware, async (c) => {
    const userId = c.get('userId');
    const txHash = await readTxHash(c);
    const data = await investorService.recordYieldClaim(userId, txHash);
    return c.json({ success: true, data });
});

export { investorRoutes };
