import { Hono } from 'hono';
import { prisma } from '../../lib/prisma.js';

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
    _count: {
        select: { transactions: true },
    },
} as const;

/**
 * GET /admin/loans
 * List all loans with pagination and filtering
 */
adminLoansRoutes.get('/', async (c) => {
    try {
        const page = parseInt(c.req.query('page') || '1');
        const limit = parseInt(c.req.query('limit') || '20');
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
    } catch (err) {
        console.error('[admin/loans] list error:', err);
        return c.json({ success: false, message: 'Failed to fetch loans' }, 500);
    }
});

/**
 * GET /admin/loans/:id
 * Get loan details with transactions
 */
adminLoansRoutes.get('/:id', async (c) => {
    try {
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
            return c.json({ success: false, message: 'Loan not found' }, 404);
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
    } catch (err) {
        console.error('[admin/loans] get error:', err);
        return c.json({ success: false, message: 'Failed to fetch loan' }, 500);
    }
});

/**
 * POST /admin/loans/:id/liquidate
 * Manually trigger liquidation
 */
adminLoansRoutes.post('/:id/liquidate', async (c) => {
    try {
        const id = c.req.param('id');

        const loan = await prisma.loan.findUnique({ where: { id } });
        if (!loan) {
            return c.json({ success: false, message: 'Loan not found' }, 404);
        }

        if (loan.status !== 'ACTIVE') {
            return c.json({ success: false, message: 'Only active loans can be liquidated' }, 400);
        }

        await prisma.loan.update({
            where: { id },
            data: {
                status: 'LIQUIDATED',
                liquidatedAt: new Date(),
            },
        });

        return c.json({
            success: true,
            message: 'Liquidation triggered',
        });
    } catch (err) {
        console.error('[admin/loans] liquidate error:', err);
        return c.json({ success: false, message: 'Failed to trigger liquidation' }, 500);
    }
});

export { adminLoansRoutes };
