/**
 * Loan lifecycle rules that move or lock money: hash reuse, repayments that fail
 * half-way, payouts the pool cannot make yet, cancellation, extra collateral,
 * concurrent approvals, extensions and liquidation.
 *
 * The contracts' own arithmetic is covered in contracts/test/AvelonLending.t.sol.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import './prisma.mock.js';
import { mockPrismaClient } from './prisma.mock.js';
import { Prisma } from '../generated/prisma/client.js';

const D = (v: string | number) => new Prisma.Decimal(v);

const BORROWER = '0x976ea74026e726554db657fa54763abd0c3a0aa9';
const POOL = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9';
const HASH = '0x' + 'ab'.repeat(32);
const HASH_UPPER = '0x' + 'AB'.repeat(32);

vi.mock('../config/env.js', () => ({
    env: { DATABASE_URL: 'postgresql://localhost:5432/test', NODE_ENV: 'test' },
    chain: { id: 31337, minConfirmations: 1 },
}));

const chainMocks = vi.hoisted(() => ({
    verifyTransaction: vi.fn(),
    decodePoolCall: vi.fn(),
    findPoolRepaymentEvent: vi.fn(),
}));
vi.mock('../services/blockchain.service.js', () => ({ blockchainService: chainMocks }));

const contractMocks = vi.hoisted(() => ({
    createLoan: vi.fn(),
    verifyCollateralDeposit: vi.fn(),
    verifyAdditionalCollateral: vi.fn(),
    recordRepayment: vi.fn(),
    releaseCollateral: vi.fn(),
    cancelLoan: vi.fn(),
    extendLoan: vi.fn(),
    isLoanOverdue: vi.fn(),
    liquidateLoan: vi.fn(),
}));
vi.mock('../services/contract.service.js', () => ({
    contractService: contractMocks,
    LiquidationReason: { Default: 0, Shortfall: 1, 0: 'Default', 1: 'Shortfall' },
}));

const poolMocks = vi.hoisted(() => ({
    getAddress: vi.fn(),
    isConfigured: vi.fn(),
    getPoolState: vi.fn(),
    fundLoan: vi.fn(),
    getLoanPrincipal: vi.fn(),
    writeOffLoan: vi.fn(),
    recordRecovery: vi.fn(),
}));
vi.mock('../services/pool.service.js', () => ({ poolService: poolMocks }));

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock('../services/notification.service.js', () => ({ notificationService: { notify: notifyMock } }));

const { loanService } = await import('../services/loan.service.js');

function loanRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'loan1',
        userId: 'u1',
        walletId: 'w1',
        planId: 'p1',
        contractLoanId: 7,
        principal: D('0.05'),
        collateralRequired: D('0.03'),
        collateralDeposited: D('0'),
        originationFee: D('0.001'),
        principalOwed: D('0.05'),
        interestOwed: D('0.000328767123287671'),
        feesOwed: D('0'),
        interestRate: 8,
        duration: 30,
        status: 'ACTIVE',
        dueDate: new Date(Date.now() + 10 * 86400_000),
        extended: false,
        approvedBy: null,
        wallet: { id: 'w1', address: BORROWER, isVerified: true },
        plan: { name: 'VIP', extensionAllowed: true, maxExtensionDays: 30, extensionFee: 1 },
        ...overrides,
    };
}

function uniqueViolation() {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
    });
}

/** A confirmed repay(7) call from the borrower for `value` ETH. */
function goodRepayment(value: string) {
    chainMocks.verifyTransaction.mockResolvedValue({
        valid: true, chainId: 31337, from: BORROWER, to: POOL, value, data: '0xrepay', blockNumber: 9, gasUsed: '21000',
    });
    chainMocks.decodePoolCall.mockReturnValue({ name: 'repay', args: [7n] });
    chainMocks.findPoolRepaymentEvent.mockResolvedValue({ principal: '0.05', interest: '0' });
}

beforeEach(() => {
    vi.clearAllMocks();
    const m = mockPrismaClient as any;

    m.loan = {
        findFirst: vi.fn().mockResolvedValue(loanRow()),
        findUnique: vi.fn().mockResolvedValue(loanRow()),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'new', ...data })),
        update: vi.fn().mockImplementation(({ data }) => Promise.resolve(loanRow(data))),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
    };
    m.loanTransaction = {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'tx1' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
    };
    m.wallet = { ...m.wallet, findUnique: vi.fn().mockResolvedValue({ id: 'w1', address: BORROWER, isVerified: true }), findFirst: vi.fn() };
    m.user = { ...m.user, update: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue({ creditScore: 50, status: 'CONNECTED' }) };
    m.auditLog = { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) };
    m.poolTransaction = { create: vi.fn().mockResolvedValue({}) };
    m.liquidityPool = { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() };
    m.loanPlan = { ...m.loanPlan, findUnique: vi.fn() };
    m.systemConfig = { findUnique: vi.fn().mockResolvedValue(null) };
    m.$executeRaw = vi.fn().mockResolvedValue(1);
    m.$transaction = vi.fn().mockImplementation((arg: unknown) =>
        typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(m) : Promise.all(arg as unknown[]),
    );

    poolMocks.getAddress.mockReturnValue(POOL);
    poolMocks.isConfigured.mockReturnValue(false);
    poolMocks.getLoanPrincipal.mockResolvedValue('0.0');
    poolMocks.fundLoan.mockResolvedValue({ txHash: '0xfund', blockNumber: 3, gasUsed: '1' });
    contractMocks.recordRepayment.mockResolvedValue({ txHash: '0xrec', remainingOwed: '0' });
    contractMocks.releaseCollateral.mockResolvedValue('0xrel');
    contractMocks.cancelLoan.mockResolvedValue('0xcancel');
    contractMocks.extendLoan.mockResolvedValue('0xext');
    notifyMock.mockResolvedValue(undefined);
});

// ─── transaction hashes ─────────────────────────────────────────────────

describe('transaction hashes are compared case-insensitively', () => {
    it('refuses an uppercase copy of a recorded collateral hash', async () => {
        mockPrismaClient.loan.findFirst = vi.fn().mockResolvedValue(loanRow({ status: 'PENDING_COLLATERAL' }));
        (mockPrismaClient as any).loanTransaction.findUnique = vi.fn(({ where }) =>
            Promise.resolve(where.txHash === HASH ? { id: 'old' } : null));

        await expect(loanService.recordCollateralDeposit('loan1', 'u1', HASH_UPPER)).rejects.toThrow(/already been used/);
        expect(contractMocks.verifyCollateralDeposit).not.toHaveBeenCalled();
    });

    it('refuses an uppercase copy of a recorded repayment hash', async () => {
        (mockPrismaClient as any).loanTransaction.findUnique = vi.fn(({ where }) =>
            Promise.resolve(where.txHash === HASH ? { id: 'old', confirmed: true } : null));

        await expect(loanService.recordRepayment('loan1', 'u1', '0.01', HASH_UPPER)).rejects.toThrow(/already been used/);
        expect(chainMocks.verifyTransaction).not.toHaveBeenCalled();
    });

    it('stores the hash in lowercase', async () => {
        goodRepayment('0.01');
        await loanService.recordRepayment('loan1', 'u1', '0.01', HASH_UPPER);
        const created = (mockPrismaClient as any).loanTransaction.create.mock.calls[0][0].data;
        expect(created.txHash).toBe(HASH);
    });
});

// ─── repayment ──────────────────────────────────────────────────────────

describe('recording a repayment', () => {
    it('claims the hash before writing to the chain', async () => {
        goodRepayment('0.01');
        await loanService.recordRepayment('loan1', 'u1', '0.01', HASH);

        const claimOrder = (mockPrismaClient as any).loanTransaction.create.mock.invocationCallOrder[0];
        const chainOrder = contractMocks.recordRepayment.mock.invocationCallOrder[0];
        expect(claimOrder).toBeLessThan(chainOrder);
        expect((mockPrismaClient as any).loanTransaction.create.mock.calls[0][0].data.confirmed).toBe(false);
    });

    it('frees the hash for a retry when the on-chain record fails', async () => {
        goodRepayment('0.01');
        contractMocks.recordRepayment.mockRejectedValueOnce(new Error('nonce too high'));

        await expect(loanService.recordRepayment('loan1', 'u1', '0.01', HASH)).rejects.toThrow(/try again/i);
        expect((mockPrismaClient as any).loanTransaction.delete).toHaveBeenCalledWith({ where: { txHash: HASH } });
        expect(mockPrismaClient.loan.update).not.toHaveBeenCalled();
    });

    it('turns a concurrent duplicate into a clean refusal', async () => {
        goodRepayment('0.01');
        (mockPrismaClient as any).loanTransaction.create = vi.fn().mockRejectedValue(uniqueViolation());

        await expect(loanService.recordRepayment('loan1', 'u1', '0.01', HASH)).rejects.toThrow(/already been used/);
        expect(contractMocks.recordRepayment).not.toHaveBeenCalled();
    });

    it('reports a hash that is still being processed', async () => {
        (mockPrismaClient as any).loanTransaction.findUnique = vi.fn().mockResolvedValue({ id: 'old', confirmed: false });
        await expect(loanService.recordRepayment('loan1', 'u1', '0.01', HASH)).rejects.toThrow(/being processed/);
    });

    it('confirms the claim and the new balance together', async () => {
        goodRepayment('0.01');
        await loanService.recordRepayment('loan1', 'u1', '0.01', HASH);

        expect(mockPrismaClient.$transaction).toHaveBeenCalled();
        expect((mockPrismaClient as any).loanTransaction.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { txHash: HASH }, data: expect.objectContaining({ confirmed: true }) }),
        );
    });

    it('keeps a paid-off loan open when the stake cannot be released yet', async () => {
        goodRepayment('0.050328767123287671');
        contractMocks.releaseCollateral.mockRejectedValueOnce(new Error('rpc down'));

        const result = await loanService.recordRepayment('loan1', 'u1', '0.050328767123287671', HASH);

        expect(result.collateralReleasePending).toBe(true);
        const statusWrites = mockPrismaClient.loan.update.mock.calls.map((c: any[]) => c[0].data.status);
        expect(statusWrites).not.toContain('REPAID');
    });

    it('closes the loan once the stake release is retried', async () => {
        mockPrismaClient.loan.findUnique = vi.fn().mockResolvedValue(loanRow({
            principalOwed: D(0), interestOwed: D(0), feesOwed: D(0),
        }));

        await loanService.completeRepaidLoan('loan1');

        expect(contractMocks.releaseCollateral).toHaveBeenCalledWith(7);
        expect(mockPrismaClient.loan.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'REPAID' }) }),
        );
        expect(mockPrismaClient.user.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ activeLoansCount: { decrement: 1 } }),
        }));
    });

    it('will not release the stake while anything is still owed', async () => {
        await expect(loanService.completeRepaidLoan('loan1')).rejects.toThrow(/still owed/);
        expect(contractMocks.releaseCollateral).not.toHaveBeenCalled();
    });
});

// ─── collateral and payout ──────────────────────────────────────────────

describe('collateral and payout', () => {
    beforeEach(() => {
        mockPrismaClient.loan.findFirst = vi.fn().mockResolvedValue(loanRow({ status: 'PENDING_COLLATERAL' }));
        contractMocks.verifyCollateralDeposit.mockResolvedValue({ verified: true, amount: '0.03', blockNumber: 5, gasUsed: '1' });
    });

    it('keeps the deposit when the pool cannot pay out yet', async () => {
        mockPrismaClient.loan.findUnique = vi.fn().mockResolvedValue(loanRow({ status: 'COLLATERAL_DEPOSITED', collateralDeposited: D('0.03') }));
        const { AppError } = await import('../middleware/error.middleware.js');
        poolMocks.fundLoan.mockRejectedValueOnce(new AppError(409, 'INSUFFICIENT_POOL_LIQUIDITY', 'pool short'));

        const result = await loanService.recordCollateralDeposit('loan1', 'u1', HASH);

        expect(result.payoutPending).toBe(true);
        expect(result.loan.status).toBe('COLLATERAL_DEPOSITED');
        expect((mockPrismaClient as any).loanTransaction.create).toHaveBeenCalled();
    });

    it('refuses when another request already recorded the deposit', async () => {
        mockPrismaClient.loan.updateMany = vi.fn().mockResolvedValue({ count: 0 });
        await expect(loanService.recordCollateralDeposit('loan1', 'u1', HASH)).rejects.toThrow(/no longer awaiting collateral/);
    });

    it('retries a pending payout', async () => {
        mockPrismaClient.loan.findUnique = vi.fn().mockResolvedValue(loanRow({ status: 'COLLATERAL_DEPOSITED', collateralDeposited: D('0.03') }));

        await loanService.retryDisbursement('loan1');

        expect(poolMocks.fundLoan).toHaveBeenCalledWith(7, BORROWER, '0.049');
        expect(mockPrismaClient.loan.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
        );
    });

    it('does not pay twice when the pool already funded the loan', async () => {
        mockPrismaClient.loan.findUnique = vi.fn().mockResolvedValue(loanRow({ status: 'COLLATERAL_DEPOSITED', collateralDeposited: D('0.03') }));
        poolMocks.getLoanPrincipal.mockResolvedValue('0.049');

        await loanService.retryDisbursement('loan1');

        expect(poolMocks.fundLoan).not.toHaveBeenCalled();
        expect(mockPrismaClient.loan.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
        );
    });

    it('only retries loans that are waiting for a payout', async () => {
        await expect(loanService.retryDisbursement('loan1')).rejects.toThrow(/not waiting for a payout/);
    });

    it('records extra collateral on an active loan', async () => {
        contractMocks.verifyAdditionalCollateral.mockResolvedValue({ verified: true, amount: '0.01', blockNumber: 6, gasUsed: '1' });
        mockPrismaClient.loan.findFirst = vi.fn().mockResolvedValue(loanRow({ collateralDeposited: D('0.03') }));

        const result = await loanService.recordAdditionalCollateral('loan1', 'u1', HASH);

        expect(contractMocks.verifyAdditionalCollateral).toHaveBeenCalledWith(7, HASH, BORROWER);
        expect(mockPrismaClient.loan.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { collateralDeposited: { increment: D('0.01') } } }),
        );
        expect(result.loan).toBeDefined();
    });

    it('refuses extra collateral on a loan that is not active', async () => {
        await expect(loanService.recordAdditionalCollateral('loan1', 'u1', HASH)).rejects.toThrow(/active/);
    });
});

// ─── cancellation ───────────────────────────────────────────────────────

describe('cancelling a loan', () => {
    beforeEach(() => {
        mockPrismaClient.loan.findFirst = vi.fn().mockResolvedValue(loanRow({ status: 'PENDING_COLLATERAL' }));
    });

    it('cancels on-chain before the database', async () => {
        await loanService.cancelLoan('loan1', 'u1');
        expect(contractMocks.cancelLoan).toHaveBeenCalledWith(7);
        expect(contractMocks.cancelLoan.mock.invocationCallOrder[0])
            .toBeLessThan(mockPrismaClient.loan.updateMany.mock.invocationCallOrder[0]);
    });

    it('leaves the loan alone when the chain refuses', async () => {
        contractMocks.cancelLoan.mockRejectedValueOnce(new Error('InvalidLoanStatus'));
        await expect(loanService.cancelLoan('loan1', 'u1')).rejects.toThrow(/collateral may already/);
        expect(mockPrismaClient.loan.updateMany).not.toHaveBeenCalled();
    });

    it('lets a borrower withdraw an application still under review', async () => {
        mockPrismaClient.loan.findFirst = vi.fn().mockResolvedValue(loanRow({ status: 'PENDING_APPROVAL', contractLoanId: null }));
        await loanService.cancelLoan('loan1', 'u1');
        expect(contractMocks.cancelLoan).not.toHaveBeenCalled();
        expect(mockPrismaClient.loan.updateMany).toHaveBeenCalledWith({
            where: { id: 'loan1', status: 'PENDING_APPROVAL', approvedBy: null },
            data: { status: 'CANCELLED' },
        });
    });

    it('refuses an application an admin is approving right now', async () => {
        mockPrismaClient.loan.findFirst = vi.fn().mockResolvedValue(loanRow({ status: 'PENDING_APPROVAL', contractLoanId: null, approvedBy: 'admin1' }));
        await expect(loanService.cancelLoan('loan1', 'u1')).rejects.toThrow(/being reviewed/);
    });
});

// ─── applications and approval ──────────────────────────────────────────

describe('applications and approval', () => {
    const plan = {
        id: 'p1', isActive: true, minAmount: D('0.01'), maxAmount: D('0.1'), durationOptions: [7, 14, 30],
        minCreditScore: 30, collateralRatio: 60, originationFee: 2, interestRate: 8,
    };

    beforeEach(() => {
        mockPrismaClient.wallet.findFirst = vi.fn().mockResolvedValue({ id: 'w1', isVerified: true, chainId: 31337 });
        mockPrismaClient.loan.findFirst = vi.fn().mockResolvedValue(null);
        (mockPrismaClient as any).loanPlan.findUnique = vi.fn().mockResolvedValue(plan);
    });

    it('refuses an amount finer than one wei', async () => {
        await expect(loanService.createLoan({
            userId: 'u1', walletId: 'w1', planId: 'p1', amount: '0.0100000000000000001', duration: 30, purpose: 'rent',
        })).rejects.toThrow(/18 decimal/);
        expect(mockPrismaClient.loan.create).not.toHaveBeenCalled();
    });

    it('serialises applications per borrower', async () => {
        await loanService.createLoan({ userId: 'u1', walletId: 'w1', planId: 'p1', amount: '0.05', duration: 30, purpose: 'rent' });
        expect(mockPrismaClient.$transaction).toHaveBeenCalledWith(expect.any(Function));
        expect(mockPrismaClient.$executeRaw).toHaveBeenCalled();
        expect(mockPrismaClient.$executeRaw.mock.invocationCallOrder[0])
            .toBeLessThan(mockPrismaClient.loan.findFirst.mock.invocationCallOrder[0]);
    });

    it('lets only one admin approve a loan', async () => {
        mockPrismaClient.loan.findUnique = vi.fn().mockResolvedValue(loanRow({ status: 'PENDING_APPROVAL', contractLoanId: null }));
        mockPrismaClient.loan.updateMany = vi.fn().mockResolvedValue({ count: 0 });

        await expect(loanService.approveLoan('loan1', 'admin2')).rejects.toThrow(/already being approved/);
        expect(contractMocks.createLoan).not.toHaveBeenCalled();
    });

    it('releases the approval claim when the chain write fails', async () => {
        mockPrismaClient.loan.findUnique = vi.fn().mockResolvedValue(loanRow({ status: 'PENDING_APPROVAL', contractLoanId: null }));
        contractMocks.createLoan.mockRejectedValueOnce(new Error('rpc down'));

        await expect(loanService.approveLoan('loan1', 'admin1')).rejects.toThrow(/remains pending/);
        expect(mockPrismaClient.loan.updateMany).toHaveBeenLastCalledWith({
            where: { id: 'loan1', status: 'PENDING_APPROVAL', approvedBy: 'admin1' },
            data: { approvedBy: null },
        });
    });

    it('lists loans with the exact amount owed', async () => {
        mockPrismaClient.loan.findMany = vi.fn().mockResolvedValue([loanRow()]);
        const [loan] = await loanService.getUserLoans('u1');
        expect(loan.totalOwed).toBe('0.050328767123287671');
    });
});

// ─── extension ──────────────────────────────────────────────────────────

describe('extending a loan', () => {
    it('extends on-chain with the fee before touching the database', async () => {
        await loanService.extendLoan('loan1', 'u1', 30);

        expect(contractMocks.extendLoan).toHaveBeenCalledWith(7, 30 * 86400, '0.0005');
        expect(contractMocks.extendLoan.mock.invocationCallOrder[0])
            .toBeLessThan(mockPrismaClient.loan.update.mock.invocationCallOrder[0]);
    });

    it('re-arms the overdue warning for the new due date', async () => {
        await loanService.extendLoan('loan1', 'u1', 30);
        expect(mockPrismaClient.loan.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ liquidationWarningAt: null }) }),
        );
    });

    it('leaves the loan unchanged when the chain refuses', async () => {
        contractMocks.extendLoan.mockRejectedValueOnce(new Error('rpc down'));
        await expect(loanService.extendLoan('loan1', 'u1', 30)).rejects.toThrow(/could not be extended/);
        expect(mockPrismaClient.loan.update).not.toHaveBeenCalled();
    });

    it('refuses a loan that is already past due', async () => {
        mockPrismaClient.loan.findFirst = vi.fn().mockResolvedValue(loanRow({ dueDate: new Date(Date.now() - 1000) }));
        await expect(loanService.extendLoan('loan1', 'u1', 30)).rejects.toThrow(/past its due date/);
    });
});

// ─── liquidation ────────────────────────────────────────────────────────

describe('liquidating a loan', () => {
    beforeEach(() => {
        contractMocks.isLoanOverdue.mockResolvedValue(true);
        contractMocks.liquidateLoan.mockResolvedValue('0xliq');
        poolMocks.isConfigured.mockReturnValue(true);
        poolMocks.getLoanPrincipal.mockResolvedValue('0.049');
        poolMocks.writeOffLoan.mockResolvedValue('0xoff');
        poolMocks.recordRecovery.mockResolvedValue('0xrecover');
        mockPrismaClient.loan.findUnique = vi.fn().mockResolvedValue(loanRow({ collateralDeposited: D('0.03') }));
    });

    it('refuses a reason the contract cannot accept', async () => {
        await expect(loanService.liquidateLoan('loan1', 'admin1', 'SHORTFALL')).rejects.toThrow(/Only a missed due date/);
        expect(contractMocks.liquidateLoan).not.toHaveBeenCalled();
    });

    it('refuses a loan that is not overdue on-chain', async () => {
        contractMocks.isLoanOverdue.mockResolvedValue(false);
        await expect(loanService.liquidateLoan('loan1', 'admin1')).rejects.toThrow(/not overdue/);
        expect(contractMocks.liquidateLoan).not.toHaveBeenCalled();
    });

    it('records the default against the borrower', async () => {
        await loanService.liquidateLoan('loan1', 'admin1');
        expect(mockPrismaClient.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { activeLoansCount: { decrement: 1 }, defaultCount: { increment: 1 } },
        });
    });

    it('reports pool settlement that still has to be retried', async () => {
        poolMocks.writeOffLoan.mockRejectedValueOnce(new Error('rpc down'));
        const result = await loanService.liquidateLoan('loan1', 'admin1');
        expect(result.settlementPending).toBe(true);
    });

    it('settles a liquidated loan without sending the recovery twice', async () => {
        mockPrismaClient.loan.findUnique = vi.fn().mockResolvedValue(loanRow({ status: 'LIQUIDATED', collateralDeposited: D('0.03') }));
        (mockPrismaClient as any).auditLog.findFirst = vi.fn().mockResolvedValue({ id: 'sent' });

        const result = await loanService.settleLiquidation('loan1', 'admin1');

        expect(poolMocks.writeOffLoan).toHaveBeenCalledWith(7, '0.049');
        expect(poolMocks.recordRecovery).not.toHaveBeenCalled();
        expect(result.settlementPending).toBe(false);
    });
});
