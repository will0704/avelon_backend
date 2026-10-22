/**
 * The jobs that move a loan toward liquidation: due-date reminders, advisory
 * margin calls on big price moves, overdue warnings and opt-in automatic
 * liquidation, plus the clock that lets a fast-forwarded local chain drive them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';

const D = (v: string | number) => new Prisma.Decimal(v);
const DAY = 86400_000;

const env = vi.hoisted(() => ({
    NODE_ENV: 'test',
    ETH_PHP_RATE: 150000,
    REMINDER_DAYS_BEFORE: 3,
    MARGIN_CALL_MOVE_PERCENT: 15,
    AUTO_LIQUIDATE_AFTER_HOURS: undefined as number | undefined,
}));
const chainCfg = vi.hoisted(() => ({ id: 31337, minConfirmations: 1 }));
vi.mock('../config/env.js', () => ({ env, chain: chainCfg }));

const db = vi.hoisted(() => ({
    loan: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
}));
vi.mock('../lib/prisma.js', () => ({ prisma: db }));

const send = vi.hoisted(() => vi.fn());
vi.mock('../services/blockchain.service.js', () => ({ blockchainService: { getProvider: () => ({ send }) } }));

const notify = vi.hoisted(() => vi.fn());
vi.mock('../services/notification.service.js', () => ({ notificationService: { notify } }));

const forecast = vi.hoisted(() => vi.fn());
vi.mock('../services/volatility.service.js', () => ({ getVolatilityForecast: forecast }));

const liquidateLoan = vi.hoisted(() => vi.fn());
vi.mock('../services/loan.service.js', () => ({ loanService: { liquidateLoan } }));

const clock = await import('../lib/clock.js');
const { sendRepaymentReminders } = await import('../jobs/repayment-reminders.job.js');
const { runRiskMonitor, assessLoan } = await import('../jobs/risk-monitor.job.js');
const { flagOverdueLoans } = await import('../jobs/overdue-loans.job.js');
const { autoLiquidateOverdue } = await import('../jobs/auto-liquidate.job.js');

function activeLoan(overrides: Record<string, unknown> = {}) {
    return {
        id: 'loan1',
        userId: 'u1',
        status: 'ACTIVE',
        contractLoanId: 3,
        principalOwed: D('0.1'),
        interestOwed: D('0.000657'),
        feesOwed: D('0'),
        collateralDeposited: D('0.06'),
        ethPriceSnapshot: D('150000'),
        dueDate: new Date(Date.now() + 2 * DAY),
        marginCallAt: null,
        reminderSentAt: null,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    env.AUTO_LIQUIDATE_AFTER_HOURS = undefined;
    chainCfg.id = 31337;
    // Chain time equal to wall time unless a test moves it
    send.mockImplementation(async () => ({ timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) }));
    db.loan.findMany.mockResolvedValue([]);
    db.loan.updateMany.mockResolvedValue({ count: 1 });
    db.loan.update.mockResolvedValue({});
    db.systemConfig.findUnique.mockResolvedValue({ value: '150000' });
    forecast.mockResolvedValue({ online: true, riskLevel: 'LOW' });
    notify.mockResolvedValue(undefined);
    liquidateLoan.mockResolvedValue({ txHash: '0xliq', settlementPending: false });
});

describe('chain-following clock', () => {
    it('runs ahead of wall time by however far the local chain was fast-forwarded', async () => {
        send.mockResolvedValue({ timestamp: '0x' + Math.floor((Date.now() + 10 * DAY) / 1000).toString(16) });
        const offset = await clock.syncClock();
        expect(offset).toBeGreaterThan(10 * DAY - 2000);
        expect(clock.now().getTime() - Date.now()).toBeGreaterThan(10 * DAY - 2000);
        expect(send).toHaveBeenCalledWith('eth_getBlockByNumber', ['pending', false]);
    });

    it('is plain wall time on any other chain', async () => {
        chainCfg.id = 84532;
        send.mockClear();
        expect(await clock.syncClock()).toBe(0);
        expect(send).not.toHaveBeenCalled();
    });
});

describe('repayment reminders', () => {
    it('reminds a borrower once, inside the reminder window', async () => {
        await clock.syncClock();
        db.loan.findMany.mockResolvedValue([activeLoan()]);

        expect(await sendRepaymentReminders()).toBe(1);

        const [query] = db.loan.findMany.mock.calls[0];
        expect(query.where.reminderSentAt).toBeNull();
        expect(query.where.dueDate.lte.getTime() - query.where.dueDate.gt.getTime()).toBe(3 * DAY);
        expect(db.loan.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'loan1', reminderSentAt: null } }));
        expect(notify).toHaveBeenCalledWith('u1', expect.objectContaining({
            type: 'REPAYMENT_REMINDER',
            metadata: expect.objectContaining({ amountDue: '0.100657' }),
        }), { wait: true });
    });

    it('skips a loan another run already claimed', async () => {
        db.loan.findMany.mockResolvedValue([activeLoan()]);
        db.loan.updateMany.mockResolvedValue({ count: 0 });
        expect(await sendRepaymentReminders()).toBe(0);
        expect(notify).not.toHaveBeenCalled();
    });

    it('does not remind about a loan that is already paid off', async () => {
        db.loan.findMany.mockResolvedValue([activeLoan({ principalOwed: D(0), interestOwed: D(0) })]);
        expect(await sendRepaymentReminders()).toBe(0);
    });
});

describe('margin calls', () => {
    it('measures LTV in ETH and exposure in pesos', () => {
        const risk = assessLoan(activeLoan(), 120000);
        expect(risk.ltvPercent).toBe(167.8);
        expect(risk.priceMovePercent).toBe(-20);
        expect(risk.stakeValuePHP).toBe(7200);
        expect(risk.owedValuePHP).toBe(12079);
    });

    it('warns when ETH/PHP falls past the threshold, and says price cannot seize the stake', async () => {
        db.systemConfig.findUnique.mockResolvedValue({ value: '120000' });
        db.loan.findMany.mockResolvedValue([activeLoan()]);

        expect(await runRiskMonitor()).toBe(1);

        const [, payload] = notify.mock.calls[0];
        expect(payload.type).toBe('COLLATERAL_WARNING');
        expect(payload.message).toMatch(/fallen 20\.0%/);
        expect(payload.message).toMatch(/never seizes your stake/);
        expect(payload.metadata).toEqual(expect.objectContaining({ loanId: 'loan1', priceMovePercent: -20, ethPricePHP: 120000 }));
        expect(db.loan.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'loan1', marginCallAt: null } }));
    });

    it('stays quiet for a small move with a calm forecast', async () => {
        db.systemConfig.findUnique.mockResolvedValue({ value: '142500' });
        db.loan.findMany.mockResolvedValue([activeLoan()]);
        expect(await runRiskMonitor()).toBe(0);
        expect(notify).not.toHaveBeenCalled();
    });

    it('warns on a HIGH volatility forecast even without a move yet', async () => {
        forecast.mockResolvedValue({ online: true, riskLevel: 'HIGH' });
        db.loan.findMany.mockResolvedValue([activeLoan()]);
        expect(await runRiskMonitor()).toBe(1);
        expect(notify.mock.calls[0][1].message).toMatch(/forecast is HIGH/);
    });

    it('only looks at loans not warned in the last day', async () => {
        await runRiskMonitor();
        const [query] = db.loan.findMany.mock.calls[0];
        expect(query.where.status).toBe('ACTIVE');
        expect(query.where.OR[0]).toEqual({ marginCallAt: null });
        expect(Date.now() - query.where.OR[1].marginCallAt.lt.getTime()).toBeGreaterThanOrEqual(DAY - 2000);
    });
});

describe('overdue warnings', () => {
    it('names the seizure time when auto-liquidation is on', async () => {
        env.AUTO_LIQUIDATE_AFTER_HOURS = 24;
        const dueDate = new Date(Date.now() - DAY / 2);
        db.loan.findMany.mockResolvedValue([activeLoan({ dueDate })]);

        expect(await flagOverdueLoans()).toBe(1);

        const [, payload] = notify.mock.calls[0];
        expect(payload.type).toBe('REPAYMENT_OVERDUE');
        expect(payload.metadata.liquidatesAt).toBe(new Date(dueDate.getTime() + DAY).toISOString());
        expect(payload.message).toMatch(/will be seized/);
    });

    it('uses the chain clock, so a fast-forwarded loan shows up as overdue', async () => {
        send.mockResolvedValue({ timestamp: '0x' + Math.floor((Date.now() + 40 * DAY) / 1000).toString(16) });
        await flagOverdueLoans();
        const [query] = db.loan.findMany.mock.calls[0];
        expect(query.where.dueDate.lt.getTime()).toBeGreaterThan(Date.now() + 39 * DAY);
    });
});

describe('automatic liquidation', () => {
    it('does nothing unless AUTO_LIQUIDATE_AFTER_HOURS is set', async () => {
        db.loan.findMany.mockResolvedValue([activeLoan({ dueDate: new Date(Date.now() - 10 * DAY) })]);
        expect(await autoLiquidateOverdue()).toBe(0);
        expect(db.loan.findMany).not.toHaveBeenCalled();
        expect(liquidateLoan).not.toHaveBeenCalled();
    });

    it('liquidates loans past the grace period with no admin attached', async () => {
        env.AUTO_LIQUIDATE_AFTER_HOURS = 24;
        db.loan.findMany.mockResolvedValue([
            activeLoan({ id: 'late', dueDate: new Date(Date.now() - 3 * DAY) }),
            activeLoan({ id: 'paid', principalOwed: D(0), interestOwed: D(0) }),
        ]);

        expect(await autoLiquidateOverdue()).toBe(1);

        expect(liquidateLoan).toHaveBeenCalledTimes(1);
        expect(liquidateLoan).toHaveBeenCalledWith('late', null);
        const [query] = db.loan.findMany.mock.calls[0];
        expect(Date.now() - query.where.dueDate.lt.getTime()).toBeGreaterThanOrEqual(DAY - 2000);
    });

    it('moves on when the contract refuses a loan', async () => {
        env.AUTO_LIQUIDATE_AFTER_HOURS = 0;
        db.loan.findMany.mockResolvedValue([activeLoan({ id: 'a' }), activeLoan({ id: 'b' })]);
        liquidateLoan.mockRejectedValueOnce(new Error('This loan is not overdue on-chain yet'));
        expect(await autoLiquidateOverdue()).toBe(1);
        expect(liquidateLoan).toHaveBeenCalledTimes(2);
    });
});
