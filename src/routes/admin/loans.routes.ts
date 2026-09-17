import { Hono } from 'hono';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../middleware/error.middleware.js';
import { loanService } from '../../services/loan.service.js';

const adminLoansRoutes = new Hono();

const loanSelect = {
    id: true,
    userId: true,
    walletId: true,
    planId: true,
    contractAddress: true,
    contractLoanId: true,
    principal: true,
    collateralRequired: true,
    collateralDeposited: true,
    duration: true,
    interestRate: true,
    originationFee: true,
    principalOwed: true,
    interestOwed: true,
    feesOwed: true,
    status: true,
    // The admin decides on these, so the review screen has to show them
    purpose: true,
    rejectionReason: true,
    approvedAt: true,
    rejectedAt: true,
    createdAt: true,
    collateralDepositedAt: true,
    disbursedAt: true,
    dueDate: true,
    repaidAt: true,
    liquidatedAt: true,
    extended: true,
    creditScoreSnapshot: true,
    ethPriceSnapshot: true,
    user: {
        select: {
            id: true,
            email: true,
            name: true,
            creditScore: true,
            creditTier: true,
        },
    },
    plan: {
        select: {
            id: true,
            name: true,
        },
    },
    wallet: {
        select: {
            address: true,
        },
    },
    _count: {
        select: { transactions: true },
    },
} as const;

/**
 * GET /admin/loans
 * List all loans with pagination and filtering
 */
adminLoansRoutes.get('/', async (c) => {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
    const status = c.req.query('status');
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (status) {
        where.status = status;
    }

    const [loans, total] = await Promise.all([
        prisma.loan.findMany({
            where,
            select: loanSelect,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.loan.count({ where }),
    ]);

    const mapped = loans.map((loan) => ({
        ...loan,
        principal: Number(loan.principal),
        collateralRequired: Number(loan.collateralRequired),
        collateralDeposited: Number(loan.collateralDeposited),
        originationFee: Number(loan.originationFee),
        principalOwed: Number(loan.principalOwed),
        interestOwed: Number(loan.interestOwed),
        feesOwed: Number(loan.feesOwed),
        ethPriceSnapshot: Number(loan.ethPriceSnapshot),
        transactionCount: loan._count.transactions,
        _count: undefined,
    }));

    return c.json({
        success: true,
        data: { loans: mapped },
        meta: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        },
    });
});

/**
 * GET /admin/loans/:id
 * Get loan details with transactions
 */
adminLoansRoutes.get('/:id', async (c) => {
    const id = c.req.param('id');

    const loan = await prisma.loan.findUnique({
        where: { id },
        select: {
            ...loanSelect,
            transactions: {
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
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
            },
        },
    });

    if (!loan) {
        throw new NotFoundError('Loan not found');
    }

    return c.json({
        success: true,
        data: {
            ...loan,
            principal: Number(loan.principal),
            collateralRequired: Number(loan.collateralRequired),
            collateralDeposited: Number(loan.collateralDeposited),
            originationFee: Number(loan.originationFee),
            principalOwed: Number(loan.principalOwed),
            interestOwed: Number(loan.interestOwed),
            feesOwed: Number(loan.feesOwed),
            ethPriceSnapshot: Number(loan.ethPriceSnapshot),
            transactionCount: loan._count.transactions,
            transactions: loan.transactions.map((tx) => ({
                ...tx,
                amount: Number(tx.amount),
                amountPHP: tx.amountPHP ? Number(tx.amountPHP) : null,
                ethPrice: tx.ethPrice ? Number(tx.ethPrice) : null,
            })),
            _count: undefined,
        },
    });
});

/**
 * POST /admin/loans/:id/approve
 * Approve a pending application. This is where the on-chain loan is created.
 */
adminLoansRoutes.post('/:id/approve', async (c) => {
    const id = c.req.param('id');
    const adminId = (c.get as (key: string) => string)('userId');

    const loan = await loanService.approveLoan(id, adminId);

    return c.json({
        success: true,
        message: 'Loan approved',
        data: {
            id: loan.id,
            status: loan.status,
            contractLoanId: loan.contractLoanId,
            collateralRequired: loan.collateralRequired.toString(),
        },
    });
});

/**
 * POST /admin/loans/:id/reject
 * Reject a pending application with a reason the borrower sees.
 */
adminLoansRoutes.post('/:id/reject', async (c) => {
    const id = c.req.param('id');
    const adminId = (c.get as (key: string) => string)('userId');

    const body = await c.req.json().catch(() => null);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 5) {
        throw new ValidationError('A rejection reason of at least 5 characters is required');
    }

    const loan = await loanService.rejectLoan(id, adminId, reason);

    return c.json({
        success: true,
        message: 'Loan rejected',
        data: { id: loan.id, status: loan.status, rejectionReason: loan.rejectionReason },
    });
});

/**
 * POST /admin/loans/:id/liquidate
 * Seize the stake of an overdue loan
 */
adminLoansRoutes.post('/:id/liquidate', async (c) => {
    const id = c.req.param('id');
    const adminId = (c.get as (key: string) => string)('userId');
    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;

    const result = await loanService.liquidateLoan(id, adminId, reason);

    return c.json({
        success: true,
        message: result.settlementPending
            ? 'Stake seized. Pool settlement failed and needs a retry.'
            : 'Loan liquidated',
        data: result,
    });
});

/**
 * POST /admin/loans/:id/settle
 * Retry the pool write-off and recovery after a liquidation
 */
adminLoansRoutes.post('/:id/settle', async (c) => {
    const id = c.req.param('id');
    const adminId = (c.get as (key: string) => string)('userId');
    const result = await loanService.settleLiquidation(id, adminId);
    return c.json({ success: true, message: result.settlementPending ? 'Settlement still pending' : 'Settled', data: result });
});

/**
 * POST /admin/loans/:id/disburse
 * Send a payout that the pool could not make when collateral arrived
 */
adminLoansRoutes.post('/:id/disburse', async (c) => {
    const loan = await loanService.retryDisbursement(c.req.param('id'));
    return c.json({ success: true, message: 'Payout sent', data: { id: loan?.id, status: loan?.status } });
});

/**
 * POST /admin/loans/:id/release-collateral
 * Return the stake of a paid-off loan whose release failed earlier
 */
adminLoansRoutes.post('/:id/release-collateral', async (c) => {
    const loan = await loanService.completeRepaidLoan(c.req.param('id'));
    return c.json({ success: true, message: 'Stake released', data: { id: loan?.id, status: loan?.status } });
});

export { adminLoansRoutes };
