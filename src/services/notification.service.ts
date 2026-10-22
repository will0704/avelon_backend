import { prisma } from '../lib/prisma.js';
import { firebaseService } from './firebase.service.js';
import { emailService, renderEmail } from './email.service.js';

export interface NotifyPayload {
    type: string;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
}

interface NotifyOptions {
    // Wait for push and email before returning. Jobs and tests use it; request
    // handlers don't, so a slow mail server never holds up a response.
    wait?: boolean;
}

// Which preference toggle governs a type. Anything unlisted counts as a loan update.
type Category = 'LoanUpdates' | 'RepaymentReminders' | 'LiquidationAlerts';
const CATEGORY: Record<string, Category> = {
    REPAYMENT_REMINDER: 'RepaymentReminders',
    REPAYMENT_OVERDUE: 'RepaymentReminders',
    COLLATERAL_WARNING: 'LiquidationAlerts',
    LIQUIDATION_WARNING: 'LiquidationAlerts',
    LOAN_LIQUIDATED: 'LiquidationAlerts',
};

type Tone = 'neutral' | 'success' | 'warning' | 'danger';
type Meta = Record<string, unknown>;

const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
const eth = (v: unknown) => (str(v) ? `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 })} ETH` : null);
const php = (v: unknown) => (str(v) ? `₱${Math.round(Number(v)).toLocaleString('en-US')}` : null);
const day = (v: unknown) =>
    str(v) ? new Date(String(v)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
const when = (v: unknown) =>
    str(v) ? new Date(String(v)).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
const pct = (v: unknown) => (str(v) ? `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)}%` : null);

function rows(...pairs: [string, string | null][]): [string, string][] {
    return pairs.filter((p): p is [string, string] => p[1] !== null);
}

// The events that also go out by email, with their subject, tone and detail rows
const EMAILS: Record<string, { subject: (m: Meta) => string; tone: Tone; rows?: (m: Meta) => [string, string][]; note?: string }> = {
    KYC_APPROVED: {
        subject: () => 'Your identity is verified',
        tone: 'success',
        rows: (m) => rows(['Credit score', str(m.creditScore)], ['Tier', str(m.creditTier)]),
        note: 'Next, connect your wallet in the app and choose a loan plan.',
    },
    KYC_REJECTED: {
        subject: () => "We couldn't verify your identity",
        tone: 'danger',
        note: 'Open the app and tap Re-verify to submit clearer photos.',
    },
    LOAN_APPROVED: {
        subject: () => 'Loan approved: deposit your stake',
        tone: 'success',
        rows: (m) => rows(['Loan amount', eth(m.principal)], ['Stake to deposit', eth(m.collateralRequired)]),
        note: 'Deposit the stake from the app within 7 days or the approval expires.',
    },
    LOAN_REJECTED: {
        subject: () => 'Your loan application was not approved',
        tone: 'danger',
        rows: (m) => rows(['Reason', str(m.reason)]),
        note: 'You can apply again at any time.',
    },
    LOAN_DISBURSED: {
        subject: () => 'Your loan has been paid out',
        tone: 'success',
        rows: (m) => rows(
            ['Sent to your wallet', eth(m.disbursedAmount)],
            ['Fee withheld', eth(m.originationFee)],
            ['Amount to repay', eth(m.totalOwed)],
            ['Due date', day(m.dueDate)],
        ),
        note: 'Repay in full by the due date and your stake comes back to you. Only a missed due date can cost the stake.',
    },
    REPAYMENT_REMINDER: {
        subject: (m) => `Repayment due ${day(m.dueDate) ?? 'soon'}`,
        tone: 'warning',
        rows: (m) => rows(['Amount due', eth(m.amountDue)], ['Due date', day(m.dueDate)]),
        note: 'Pay from the app so the repayment is matched to your loan.',
    },
    REPAYMENT_RECEIVED: {
        subject: () => 'Payment received',
        tone: 'success',
        rows: (m) => rows(['Paid', eth(m.amount)], ['Still owed', eth(m.remainingOwed)]),
    },
    REPAYMENT_OVERDUE: {
        subject: () => 'Your repayment is overdue',
        tone: 'danger',
        rows: (m) => rows(['Amount due', eth(m.amountDue)], ['Was due', day(m.dueDate)], ['Stake may be seized from', when(m.liquidatesAt)]),
        note: 'Repay now from the app to keep your stake.',
    },
    COLLATERAL_WARNING: {
        subject: () => 'Margin call: ETH price moved sharply',
        tone: 'warning',
        rows: (m) => rows(
            ['ETH/PHP change since you applied', pct(m.priceMovePercent)],
            ['Your stake is worth', php(m.stakeValuePHP)],
            ['You owe', eth(m.amountDue)],
            ['Which is worth', php(m.owedValuePHP)],
            ['Due date', day(m.dueDate)],
        ),
        note: 'This is a warning only. A price move never seizes your stake; missing the due date does.',
    },
    LIQUIDATION_WARNING: {
        subject: () => 'Your stake will be seized unless you repay',
        tone: 'danger',
        rows: (m) => rows(['Amount due', eth(m.amountDue)], ['Seized from', when(m.liquidatesAt)]),
    },
    LOAN_LIQUIDATED: {
        subject: () => 'Your loan was liquidated',
        tone: 'danger',
        rows: (m) => rows(['Stake seized', eth(m.collateralSeized)]),
        note: 'The seized stake was returned to the investor pool that funded the loan.',
    },
    LOAN_REPAID: {
        subject: () => 'Loan repaid: your stake is on its way back',
        tone: 'success',
        rows: (m) => rows(['Final payment', eth(m.amount)], ['Stake returned', eth(m.collateralReturned)]),
    },
    POOL_DEPOSIT: {
        subject: () => 'Deposit confirmed',
        tone: 'success',
        rows: (m) => rows(['Deposited', eth(m.amount)], ['Shares received', str(m.shares)]),
    },
    POOL_WITHDRAWAL: {
        subject: () => 'Withdrawal confirmed',
        tone: 'success',
        rows: (m) => rows(['Withdrawn', eth(m.amount)], ['Shares redeemed', str(m.shares)]),
    },
    POOL_YIELD_CLAIMED: {
        subject: () => 'Yield claimed',
        tone: 'success',
        rows: (m) => rows(['Claimed', eth(m.amount)]),
    },
};

/** The email a notification turns into, or null for types that stay in-app and push only. */
export function buildNotificationEmail(payload: NotifyPayload): { subject: string; html: string } | null {
    const spec = EMAILS[payload.type];
    if (!spec) return null;
    const meta = payload.metadata ?? {};
    return {
        subject: spec.subject(meta),
        html: renderEmail({
            preheader: payload.message,
            heading: payload.title,
            intro: payload.message,
            rows: spec.rows?.(meta),
            note: spec.note,
            tone: spec.tone,
        }),
    };
}

/**
 * NotificationService
 * Stores the in-app notification, then pushes and emails it as the user's
 * preferences allow.
 */
class NotificationService {
    /**
     * Runs after the action it reports has already happened, so a failure here
     * is logged, never thrown.
     */
    async notify(userId: string, payload: NotifyPayload, options: NotifyOptions = {}): Promise<void> {
        try {
            await prisma.notification.create({
                data: {
                    userId,
                    type: payload.type as any,
                    title: payload.title,
                    message: payload.message,
                    metadata: (payload.metadata ?? {}) as any,
                },
            });
        } catch (err) {
            console.error(`[NotificationService] Could not store ${payload.type} for user ${userId}:`, err);
            return;
        }

        const delivery = this.deliver(userId, payload).catch((err) => {
            console.error(`[NotificationService] Delivery failed for user ${userId}:`, err);
        });
        if (options.wait) await delivery;
    }

    /** Push and email, each gated by its own preference. */
    async deliver(userId: string, payload: NotifyPayload): Promise<{ pushed: boolean; emailed: boolean }> {
        const [prefs, user] = await Promise.all([
            prisma.notificationPreference.findUnique({ where: { userId } }),
            prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
        ]);
        const category = CATEGORY[payload.type] ?? 'LoanUpdates';
        // No preferences row means the defaults, which are all on
        const pushAllowed = (prefs as Record<string, unknown> | null)?.[`push${category}`] !== false;
        const emailAllowed = (prefs as Record<string, unknown> | null)?.[`email${category}`] !== false;

        const loanId = payload.metadata?.loanId;
        const tasks: Promise<boolean>[] = [];

        tasks.push(pushAllowed
            ? this.sendPush(userId, {
                title: payload.title,
                body: payload.message,
                data: { type: payload.type, ...(typeof loanId === 'string' ? { loanId } : {}) },
            })
            : Promise.resolve(false));

        const email = emailAllowed && user?.email ? buildNotificationEmail(payload) : null;
        tasks.push(email ? emailService.sendEmail(user!.email, email.subject, email.html) : Promise.resolve(false));

        const [pushed, emailed] = await Promise.all(tasks.map((t) => t.catch((err) => {
            console.error(`[NotificationService] ${payload.type} delivery error for ${userId}:`, err);
            return false;
        })));
        return { pushed, emailed };
    }

    private async sendPush(
        userId: string,
        payload: { title: string; body: string; data?: Record<string, string> }
    ): Promise<boolean> {
        const deviceTokens = await prisma.deviceToken.findMany({
            where: { userId, isActive: true },
            select: { token: true },
        });

        if (deviceTokens.length === 0) return false;

        const tokens = deviceTokens.map((t) => t.token);
        const invalidTokens = await firebaseService.sendToMultiple(tokens, payload);

        if (invalidTokens.length > 0) {
            await prisma.deviceToken.updateMany({
                where: { token: { in: invalidTokens } },
                data: { isActive: false },
            });
        }
        return invalidTokens.length < tokens.length;
    }
}

export const notificationService = new NotificationService();
