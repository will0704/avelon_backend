/**
 * Notification fan-out: every event is stored in-app, then pushed and emailed
 * as the user's preferences allow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
    notification: { create: vi.fn() },
    notificationPreference: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    deviceToken: { findMany: vi.fn(), updateMany: vi.fn() },
}));
vi.mock('../lib/prisma.js', () => ({ prisma: db }));

const sendToMultiple = vi.hoisted(() => vi.fn());
vi.mock('../services/firebase.service.js', () => ({ firebaseService: { sendToMultiple } }));

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock('../services/email.service.js', async (importActual) => {
    const actual = await importActual<typeof import('../services/email.service.js')>();
    return { renderEmail: actual.renderEmail, emailService: { sendEmail } };
});

const { notificationService, buildNotificationEmail } = await import('../services/notification.service.js');

const approved = {
    type: 'LOAN_APPROVED',
    title: 'Loan approved',
    message: 'Your 0.1 ETH loan was approved.',
    metadata: { loanId: 'l1', principal: '0.1', collateralRequired: '0.06' },
};

beforeEach(() => {
    vi.clearAllMocks();
    db.notification.create.mockResolvedValue({});
    db.notificationPreference.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue({ email: 'maria.santos@example.com' });
    db.deviceToken.findMany.mockResolvedValue([{ token: 'ExponentPushToken[abc]' }]);
    sendToMultiple.mockResolvedValue([]);
    sendEmail.mockResolvedValue(true);
});

describe('notification fan-out', () => {
    it('stores the notification, pushes it and emails it when nothing is turned off', async () => {
        await notificationService.notify('u1', approved, { wait: true });

        expect(db.notification.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ userId: 'u1', type: 'LOAN_APPROVED', title: 'Loan approved' }),
        });
        expect(sendToMultiple).toHaveBeenCalledWith(['ExponentPushToken[abc]'], expect.objectContaining({
            title: 'Loan approved',
            data: { type: 'LOAN_APPROVED', loanId: 'l1' },
        }));
        expect(sendEmail).toHaveBeenCalledWith('maria.santos@example.com', 'Loan approved: deposit your stake', expect.stringContaining('0.06 ETH'));
    });

    it('skips push but still emails when push loan updates are off', async () => {
        db.notificationPreference.findUnique.mockResolvedValue({ pushLoanUpdates: false, emailLoanUpdates: true });

        const result = await notificationService.deliver('u1', approved);

        expect(result).toEqual({ pushed: false, emailed: true });
        expect(sendToMultiple).not.toHaveBeenCalled();
        expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it('lets the repayment-reminder toggles govern reminders and overdue notices', async () => {
        db.notificationPreference.findUnique.mockResolvedValue({ emailRepaymentReminders: false, pushRepaymentReminders: true });

        const result = await notificationService.deliver('u1', {
            type: 'REPAYMENT_REMINDER', title: 'Repayment due soon', message: 'Repay 0.1 ETH', metadata: { amountDue: '0.1', dueDate: '2026-11-20T00:00:00Z' },
        });

        expect(result).toEqual({ pushed: true, emailed: false });
        expect(sendEmail).not.toHaveBeenCalled();
    });

    it('lets the liquidation-alert toggles govern margin calls and liquidations', async () => {
        db.notificationPreference.findUnique.mockResolvedValue({ emailLiquidationAlerts: false, pushLiquidationAlerts: false, emailLoanUpdates: true });

        for (const type of ['COLLATERAL_WARNING', 'LIQUIDATION_WARNING', 'LOAN_LIQUIDATED']) {
            const result = await notificationService.deliver('u1', { type, title: 't', message: 'm' });
            expect(result).toEqual({ pushed: false, emailed: false });
        }
    });

    it('keeps in-app-only events out of the mailbox', async () => {
        const result = await notificationService.deliver('u1', { type: 'KYC_SUBMITTED', title: 'Submitted', message: 'm' });
        expect(result.emailed).toBe(false);
        expect(sendEmail).not.toHaveBeenCalled();
        expect(sendToMultiple).toHaveBeenCalled();
    });

    it('reports no push when the user has no device registered', async () => {
        db.deviceToken.findMany.mockResolvedValue([]);
        const result = await notificationService.deliver('u1', approved);
        expect(result.pushed).toBe(false);
    });

    it('deactivates tokens the push service says are dead', async () => {
        sendToMultiple.mockResolvedValue(['ExponentPushToken[abc]']);
        await notificationService.deliver('u1', approved);
        expect(db.deviceToken.updateMany).toHaveBeenCalledWith({
            where: { token: { in: ['ExponentPushToken[abc]'] } },
            data: { isActive: false },
        });
    });

    it('never throws when delivery fails', async () => {
        sendEmail.mockRejectedValue(new Error('smtp down'));
        sendToMultiple.mockRejectedValue(new Error('expo down'));
        await expect(notificationService.notify('u1', approved, { wait: true })).resolves.toBeUndefined();
    });

    it('does not try to deliver what it could not store', async () => {
        db.notification.create.mockRejectedValue(new Error('db down'));
        await notificationService.notify('u1', approved, { wait: true });
        expect(sendToMultiple).not.toHaveBeenCalled();
        expect(sendEmail).not.toHaveBeenCalled();
    });
});

describe('email triggers', () => {
    // The events the goal names, each with a value its email must carry
    const cases: [string, Record<string, unknown>, RegExp, string][] = [
        ['KYC_APPROVED', { creditScore: 72, creditTier: 'STANDARD' }, /identity is verified/i, '72'],
        ['KYC_REJECTED', { reason: 'Blurry photo' }, /couldn't verify/i, 'Re-verify'],
        ['LOAN_APPROVED', { principal: '0.1', collateralRequired: '0.06' }, /approved/i, '0.06 ETH'],
        ['LOAN_REJECTED', { reason: 'Purpose unclear' }, /not approved/i, 'Purpose unclear'],
        ['LOAN_DISBURSED', { disbursedAmount: '0.098', originationFee: '0.002', totalOwed: '0.100657', dueDate: '2026-11-21T00:00:00Z' }, /paid out/i, '0.098 ETH'],
        ['REPAYMENT_REMINDER', { amountDue: '0.100657', dueDate: '2026-11-21T00:00:00Z' }, /due Nov 21, 2026/, '0.100657 ETH'],
        ['REPAYMENT_OVERDUE', { amountDue: '0.100657', dueDate: '2026-11-21T00:00:00Z' }, /overdue/i, '0.100657 ETH'],
        ['COLLATERAL_WARNING', { priceMovePercent: -20, stakeValuePHP: 7200, owedValuePHP: 12000, amountDue: '0.1', dueDate: '2026-11-21T00:00:00Z' }, /margin call/i, '-20.0%'],
        ['LOAN_LIQUIDATED', { collateralSeized: '0.06' }, /liquidated/i, '0.06 ETH'],
        ['LOAN_REPAID', { amount: '0.100657', collateralReturned: '0.06' }, /repaid/i, '0.06 ETH'],
        ['POOL_DEPOSIT', { amount: '1', shares: '1' }, /deposit confirmed/i, '1 ETH'],
        ['POOL_WITHDRAWAL', { amount: '0.5', shares: '0.49' }, /withdrawal confirmed/i, '0.5 ETH'],
        ['POOL_YIELD_CLAIMED', { amount: '0.0012' }, /yield claimed/i, '0.0012 ETH'],
    ];

    it.each(cases)('%s has a subject and carries its details', (type, metadata, subject, detail) => {
        const email = buildNotificationEmail({ type, title: 'Heading', message: 'Body text', metadata });
        expect(email).not.toBeNull();
        expect(email!.subject).toMatch(subject);
        expect(email!.html).toContain(detail);
        expect(email!.html).toContain('Body text');
        expect(email!.html).toContain('test network');
    });

    it('escapes anything a user could have typed', () => {
        const email = buildNotificationEmail({ type: 'LOAN_REJECTED', title: 'x', message: '<script>alert(1)</script>', metadata: { reason: '<b>no</b>' } });
        expect(email!.html).not.toContain('<script>');
        expect(email!.html).toContain('&lt;b&gt;no&lt;/b&gt;');
    });

    it('drops detail rows whose value is missing', () => {
        const email = buildNotificationEmail({ type: 'LOAN_DISBURSED', title: 'x', message: 'y', metadata: { disbursedAmount: '0.098' } });
        expect(email!.html).toContain('Sent to your wallet');
        expect(email!.html).not.toContain('Due date');
    });
});
