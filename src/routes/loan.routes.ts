import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const loanRoutes = new Hono();

// Validation schemas
const createLoanSchema = z.object({
    planId: z.string().min(1, 'Plan ID is required'),
    amount: z.string().regex(/^\d+\.?\d*$/, 'Invalid amount format'),
    duration: z.number().int().positive('Duration must be a positive integer'),
    walletId: z.string().min(1, 'Wallet ID is required'),
});

const recordCollateralSchema = z.object({
    txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid transaction hash'),
});

const recordRepaymentSchema = z.object({
    amount: z.string().regex(/^\d+\.?\d*$/, 'Invalid amount format'),
    txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid transaction hash'),
});

/**
 * GET /loans
 * List user's loans
 */
loanRoutes.get('/', async (c) => {
    const status = c.req.query('status');

    // TODO: Implement with auth middleware and filtering
    return c.json({
        success: true,
        data: [],
        meta: {
            total: 0,
            page: 1,
            limit: 20,
        },
    });
});

/**
 * POST /loans
 * Create a new loan application
 */
loanRoutes.post('/', zValidator('json', createLoanSchema), async (c) => {
    const body = c.req.valid('json');

    // TODO: Implement loan creation with eligibility check
    return c.json({
        success: true,
        message: 'Loan application created',
        data: {
            id: 'loan_id',
            status: 'PENDING_COLLATERAL',
            principal: body.amount,
            collateralRequired: (parseFloat(body.amount) * 1.5).toFixed(4),
            duration: body.duration,
            dueDate: new Date(Date.now() + body.duration * 24 * 60 * 60 * 1000).toISOString(),
        },
    }, 201);
});

/**
 * GET /loans/:id
 * Get loan details
 */
loanRoutes.get('/:id', async (c) => {
    const id = c.req.param('id');

    // TODO: Implement loan lookup
    return c.json({
        success: true,
        data: {
            id,
            status: 'ACTIVE',
            principal: '0.5',
            collateralDeposited: '0.75',
            principalOwed: '0.5',
            interestOwed: '0.025',
            dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
    });
});

/**
 * POST /loans/:id/collateral
 * Record collateral deposit
 */
loanRoutes.post('/:id/collateral', zValidator('json', recordCollateralSchema), async (c) => {
    const id = c.req.param('id');
    const { txHash } = c.req.valid('json');

    // TODO: Implement collateral verification
    return c.json({
        success: true,
        message: 'Collateral deposit recorded',
        data: {
            loanId: id,
            txHash,
            status: 'COLLATERAL_DEPOSITED',
        },
    });
});

/**
 * POST /loans/:id/repay
 * Record repayment
 */
loanRoutes.post('/:id/repay', zValidator('json', recordRepaymentSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');

    // TODO: Implement repayment logic
    return c.json({
        success: true,
        message: 'Repayment recorded',
        data: {
            loanId: id,
            amount: body.amount,
            txHash: body.txHash,
            remaining: '0.0',
        },
    });
});

/**
 * POST /loans/:id/add-collateral
 * Add more collateral
 */
loanRoutes.post('/:id/add-collateral', zValidator('json', recordCollateralSchema), async (c) => {
    const id = c.req.param('id');
    const { txHash } = c.req.valid('json');

    // TODO: Implement collateral top-up
    return c.json({
        success: true,
        message: 'Additional collateral recorded',
        data: {
            loanId: id,
            txHash,
        },
    });
});

/**
 * POST /loans/:id/extend
 * Request loan extension (VIP only)
 */
loanRoutes.post('/:id/extend', async (c) => {
    const id = c.req.param('id');

    // TODO: Implement extension logic with VIP check
    return c.json({
        success: true,
        message: 'Loan extended successfully',
        data: {
            loanId: id,
            newDueDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        },
    });
});

/**
 * DELETE /loans/:id
 * Cancel loan (before collateral deposit)
 */
loanRoutes.delete('/:id', async (c) => {
    const id = c.req.param('id');

    // TODO: Implement loan cancellation
    return c.json({
        success: true,
        message: 'Loan cancelled',
    });
});

/**
 * GET /loans/:id/transactions
 * Get loan transactions
 */
loanRoutes.get('/:id/transactions', async (c) => {
    const id = c.req.param('id');

    // TODO: Implement transaction listing
    return c.json({
        success: true,
        data: [],
    });
});

export { loanRoutes };
