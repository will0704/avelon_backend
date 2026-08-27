import { Hono } from 'hono';
import { prisma } from '../../lib/prisma.js';
import { notificationService } from '../../services/notification.service.js';
import { contractService, LiquidationReason } from '../../services/contract.service.js';
import { NotFoundError, ValidationError } from '../../middleware/error.middleware.js';

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
 * POST /admin/loans/:id/liquidate
 * Manually trigger liquidation
 */
adminLoansRoutes.post('/:id/liquidate', async (c) => {
    const id = c.req.param('id');
    const adminId = (c.get as (key: string) => string)('userId');

    const loan = await prisma.loan.findUnique({ where: { id } });
    if (!loan) {
        throw new NotFoundError('Loan not found');
    }

    if (loan.status !== 'ACTIVE') {
        throw new ValidationError('Only active loans can be liquidated');
    }

    if (loan.contractLoanId === null) {
        throw new ValidationError('Loan has no on-chain counterpart and cannot be liquidated');
    }

    const body = await c.req.json().catch(() => ({}));
    const reason = body?.reason === 'SHORTFALL'
        ? LiquidationReason.Shortfall
        : LiquidationReason.Default;
    const observedRatioBps = reason === LiquidationReason.Shortfall
        ? Number(body?.observedRatioBps ?? 0)
        : 0;

    // Seize on-chain first. A failure here must abort the status change — the DB
    // used to be flipped on its own, which left it claiming a liquidation that
    // never happened. The contract re-checks the due date for a Default.
    const txHash = await contractService.liquidateLoan(
        loan.contractLoanId,
        reason,
        observedRatioBps
    );

    await prisma.loan.update({
        where: { id },
        data: {
            status: 'LIQUIDATED',
            liquidatedAt: new Date(),
        },
    });

    // Record audit trail — liquidation is irreversible and must be traceable
    await prisma.auditLog.create({
        data: {
            userId: adminId,
            action: 'LOAN_LIQUIDATED',
            entity: 'Loan',
            entityId: id,
            metadata: {
                borrowerId: loan.userId,
                principal: loan.principal?.toString(),
                reason: LiquidationReason[reason],
                observedRatioBps,
                txHash,
            },
        },
    });

    // Notify: liquidation executed
    await notificationService.notify(loan.userId, {
        type: 'LOAN_LIQUIDATED',
        title: '⚠️ Loan Liquidated',
        message: 'Your loan has been liquidated and your stake has been seized.',
        metadata: { loanId: id, txHash },
    });

    return c.json({
        success: true,
        message: 'Liquidation triggered',
        data: { txHash },
    });
});

export { adminLoansRoutes };
