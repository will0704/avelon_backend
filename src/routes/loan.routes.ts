import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, approvedMiddleware } from '../middleware/auth.middleware.js';
import { loanService } from '../services/loan.service.js';
import { blockchainService } from '../services/blockchain.service.js';

const loanRoutes = new Hono();

// ============================================
// VALIDATION SCHEMAS
// ============================================

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

// ============================================
// ROUTES
// ============================================

/**
 * GET /loans
 * List user's loans
 */
loanRoutes.get('/', authMiddleware, async (c) => {
    const userId = c.get('userId');
    const status = c.req.query('status');

    const loans = await loanService.getUserLoans(userId, status);

    return c.json({
        success: true,
        data: loans,
        meta: {
            total: loans.length,
        },
    });
});

/**
 * POST /loans
 * Create a new loan application
 */
loanRoutes.post(
    '/',
    authMiddleware,
    approvedMiddleware,
    zValidator('json', createLoanSchema),
    async (c) => {
        const userId = c.get('userId');
        const body = c.req.valid('json');

        const loan = await loanService.createLoan({
            userId,
            walletId: body.walletId,
            planId: body.planId,
            amount: body.amount,
            duration: body.duration,
        });

        // Get CollateralManager address for frontend
        const collateralManagerAddress = process.env.COLLATERAL_MANAGER_ADDRESS;

        return c.json({
            success: true,
            message: 'Loan application created',
            data: {
                ...loan,
                depositAddress: collateralManagerAddress,
                instruction: `Send ${loan.collateralRequired} ETH to ${collateralManagerAddress} to activate your loan`,
            },
        }, 201);
    }
);

/**
 * GET /loans/:id
 * Get loan details
 */
loanRoutes.get('/:id', authMiddleware, async (c) => {
    const userId = c.get('userId');
    const loanId = c.req.param('id');

    const loan = await loanService.getLoanById(loanId, userId);

    // Calculate total owed
    const totalOwed = loan.principalOwed
        .add(loan.interestOwed)
        .add(loan.feesOwed);

    // Get current collateral ratio if loan has collateral
    let collateralRatio = null;
    if (loan.collateralDeposited.gt(0) && totalOwed.gt(0)) {
        collateralRatio = loan.collateralDeposited
            .div(totalOwed)
            .mul(100)
            .toNumber();
    }

    return c.json({
        success: true,
        data: {
            ...loan,
            totalOwed: totalOwed.toString(),
            collateralRatio,
        },
    });
});

/**
 * POST /loans/:id/collateral
 * Record collateral deposit
 */
loanRoutes.post(
    '/:id/collateral',
    authMiddleware,
    zValidator('json', recordCollateralSchema),
    async (c) => {
        const userId = c.get('userId');
        const loanId = c.req.param('id');
        const { txHash } = c.req.valid('json');

        const result = await loanService.recordCollateralDeposit(loanId, userId, txHash);

        return c.json({
            success: true,
            message: 'Collateral deposit recorded',
            data: {
                loanId: result.loan.id,
                status: result.loan.status,
                collateralDeposited: result.loan.collateralDeposited.toString(),
                collateralRequired: result.loan.collateralRequired.toString(),
                txHash,
            },
        });
    }
);

/**
 * POST /loans/:id/repay
 * Record repayment
 */
loanRoutes.post(
    '/:id/repay',
    authMiddleware,
    zValidator('json', recordRepaymentSchema),
    async (c) => {
        const userId = c.get('userId');
        const loanId = c.req.param('id');
        const { amount, txHash } = c.req.valid('json');

        const result = await loanService.recordRepayment(loanId, userId, amount, txHash);

        return c.json({
            success: true,
            message: result.remainingOwed === '0'
                ? 'Loan fully repaid!'
                : 'Repayment recorded',
            data: {
                loanId,
                amount,
                txHash,
                remainingOwed: result.remainingOwed,
                isFullyRepaid: result.remainingOwed === '0',
            },
        });
    }
);

/**
 * POST /loans/:id/add-collateral
 * Add more collateral
 */
loanRoutes.post(
    '/:id/add-collateral',
    authMiddleware,
    zValidator('json', recordCollateralSchema),
    async (c) => {
        const userId = c.get('userId');
        const loanId = c.req.param('id');
        const { txHash } = c.req.valid('json');

        // Use same flow as initial collateral deposit
        const result = await loanService.recordCollateralDeposit(loanId, userId, txHash);

        return c.json({
            success: true,
            message: 'Additional collateral recorded',
            data: {
                loanId: result.loan.id,
                collateralDeposited: result.loan.collateralDeposited.toString(),
                txHash,
            },
        });
    }
);

/**
 * DELETE /loans/:id
 * Cancel loan (before collateral deposit)
 */
loanRoutes.delete('/:id', authMiddleware, async (c) => {
    const userId = c.get('userId');
    const loanId = c.req.param('id');

    await loanService.cancelLoan(loanId, userId);

    return c.json({
        success: true,
        message: 'Loan cancelled',
    });
});

/**
 * GET /loans/:id/transactions
 * Get loan transactions
 */
loanRoutes.get('/:id/transactions', authMiddleware, async (c) => {
    const userId = c.get('userId');
    const loanId = c.req.param('id');

    const transactions = await loanService.getLoanTransactions(loanId, userId);

    return c.json({
        success: true,
        data: transactions,
    });
});

/**
 * GET /loans/blockchain/status
 * Get blockchain connection status
 */
loanRoutes.get('/blockchain/status', authMiddleware, async (c) => {
    try {
        const networkInfo = await blockchainService.getNetworkInfo();
        const blockNumber = await blockchainService.getBlockNumber();

        return c.json({
            success: true,
            data: {
                connected: true,
                network: networkInfo.name,
                chainId: networkInfo.chainId,
                blockNumber,
                contracts: {
                    avelonLending: process.env.AVELON_LENDING_ADDRESS || null,
                    collateralManager: process.env.COLLATERAL_MANAGER_ADDRESS || null,
                    repaymentSchedule: process.env.REPAYMENT_SCHEDULE_ADDRESS || null,
                },
            },
        });
    } catch (error) {
        return c.json({
            success: true,
            data: {
                connected: false,
                error: error instanceof Error ? error.message : 'Connection failed',
            },
        });
    }
});

export { loanRoutes };
