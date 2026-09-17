import { describe, it, expect, vi, beforeEach } from 'vitest';

import './prisma.mock.js';
import { mockPrismaClient } from './prisma.mock.js';
import { Prisma } from '../generated/prisma/client.js';

const D = (v: string) => new Prisma.Decimal(v);

vi.mock('../config/env.js', () => ({
    env: { NODE_ENV: 'test' },
    chain: { id: 31337, minConfirmations: 1 },
}));

const cancelLoan = vi.hoisted(() => vi.fn());
vi.mock('../services/contract.service.js', () => ({ contractService: { cancelLoan } }));

const notify = vi.hoisted(() => vi.fn());
vi.mock('../services/notification.service.js', () => ({ notificationService: { notify } }));

const { expireStaleLoans } = await import('../jobs/expire-loans.job.js');
const { flagOverdueLoans } = await import('../jobs/overdue-loans.job.js');

beforeEach(() => {
    vi.clearAllMocks();
    const m = mockPrismaClient as any;
    m.loan = {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    m.auditLog = { create: vi.fn().mockResolvedValue({}) };
    cancelLoan.mockResolvedValue('0xc');
    notify.mockResolvedValue(undefined);
});

describe('expiring loans nobody finished', () => {
    it('expires applications left unreviewed for two weeks', async () => {
        mockPrismaClient.loan.findMany = vi.fn()
            .mockResolvedValueOnce([{ id: 'a1', userId: 'u1', status: 'PENDING_APPROVAL', contractLoanId: null }])
            .mockResolvedValueOnce([]);

        await expireStaleLoans();

        const [review] = mockPrismaClient.loan.findMany.mock.calls[0];
        expect(review.where.status).toBe('PENDING_APPROVAL');
        expect(review.where.approvedBy).toBeNull();
        expect(review.where.createdAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - 14 * 86400_000 + 1000);
        expect(mockPrismaClient.loan.updateMany).toHaveBeenCalledWith({
            where: { id: 'a1', status: 'PENDING_APPROVAL', approvedBy: null },
            data: { status: 'EXPIRED' },
        });
        expect(notify).toHaveBeenCalledWith('u1', expect.objectContaining({ title: expect.stringMatching(/expired/i) }));
    });

    it('cancels on-chain before expiring an approved loan that never got collateral', async () => {
        mockPrismaClient.loan.findMany = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: 'b1', userId: 'u2', status: 'PENDING_COLLATERAL', contractLoanId: 4 }]);

        await expireStaleLoans();

        expect(cancelLoan).toHaveBeenCalledWith(4);
        expect(mockPrismaClient.loan.updateMany).toHaveBeenCalledWith({
            where: { id: 'b1', status: 'PENDING_COLLATERAL' },
            data: { status: 'EXPIRED' },
        });
    });

    it('leaves the loan alone when the chain will not cancel it', async () => {
        mockPrismaClient.loan.findMany = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: 'b1', userId: 'u2', status: 'PENDING_COLLATERAL', contractLoanId: 4 }]);
        cancelLoan.mockRejectedValueOnce(new Error('InvalidLoanStatus'));

        await expireStaleLoans();

        expect(mockPrismaClient.loan.updateMany).not.toHaveBeenCalled();
    });
});

describe('overdue warnings', () => {
    it('does not warn about a loan that is already paid off', async () => {
        mockPrismaClient.loan.findMany = vi.fn().mockResolvedValue([
            { id: 'paid', userId: 'u1', principalOwed: D('0'), interestOwed: D('0'), feesOwed: D('0') },
            { id: 'owing', userId: 'u2', principalOwed: D('0.05'), interestOwed: D('0'), feesOwed: D('0') },
        ]);

        await flagOverdueLoans();

        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('u2', expect.anything());
    });
});
