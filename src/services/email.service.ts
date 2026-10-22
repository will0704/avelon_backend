import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../config/env.js';

// Where mail goes. "gmail" needs the four GMAIL_* values; "outbox" writes each
// message to EMAIL_OUTBOX_DIR as an .html file so local dev needs no mailbox;
// "log" only prints the subject. "auto" picks gmail when configured, otherwise
// outbox in development and log everywhere else.
export type EmailDelivery = 'gmail' | 'outbox' | 'log';

export interface OutboxEntry {
    id: string;
    to: string;
    subject: string;
    sentAt: string;
}

type Tone = 'neutral' | 'success' | 'warning' | 'danger';

interface TemplateInput {
    preheader: string;
    heading: string;
    intro: string;
    rows?: [label: string, value: string][];
    code?: string;
    note?: string;
    tone?: Tone;
}

const TONE_COLORS: Record<Tone, string> = {
    neutral: '#E85C1A',
    success: '#15803D',
    warning: '#B45309',
    danger: '#B91C1C',
};

const escapeHtml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One layout for every Avelon email: header bar, card, optional code and detail table. */
export function renderEmail(input: TemplateInput): string {
    const accent = TONE_COLORS[input.tone ?? 'neutral'];
    const rows = (input.rows ?? [])
        .map(([label, value]) => `
            <tr>
                <td style="padding:10px 0;border-top:1px solid #EEE7E1;color:#6B6460;font-size:14px;">${escapeHtml(label)}</td>
                <td style="padding:10px 0;border-top:1px solid #EEE7E1;color:#1C1917;font-size:14px;font-weight:600;text-align:right;">${escapeHtml(value)}</td>
            </tr>`)
        .join('');

    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.heading)}</title></head>
<body style="margin:0;padding:0;background:#F6F3F0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(input.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F3F0;padding:32px 16px;">
<tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding:0 4px 16px;font-size:20px;font-weight:800;letter-spacing:-0.02em;color:#1C1917;">Avelon</td></tr>
        <tr><td style="background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #EEE7E1;">
            <div style="height:6px;background:${accent};"></div>
            <div style="padding:28px 28px 24px;">
                <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#1C1917;">${escapeHtml(input.heading)}</h1>
                <p style="margin:0;font-size:15px;line-height:1.6;color:#44403C;">${escapeHtml(input.intro)}</p>
                ${input.code ? `
                <div style="margin:24px 0 8px;padding:18px;border-radius:12px;background:#FFF4EC;text-align:center;">
                    <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#1C1917;font-family:'SFMono-Regular',Menlo,monospace;">${escapeHtml(input.code)}</span>
                </div>` : ''}
                ${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">${rows}</table>` : ''}
                ${input.note ? `<p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#78716C;">${escapeHtml(input.note)}</p>` : ''}
            </div>
        </td></tr>
        <tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.6;color:#A8A29E;">
            Avelon is a capstone prototype running on a test network. Amounts are test ETH, not real money.
            You can change which emails you get under notification settings in the app.
        </td></tr>
    </table>
</td></tr>
</table>
</body>
</html>`;
}

class EmailService {
    private gmail: ReturnType<typeof google.gmail> | null = null;
    private fromAddress: string;
    readonly delivery: EmailDelivery;
    readonly outboxDir: string;
    private outboxSeq = 0;

    constructor() {
        this.fromAddress = env.GMAIL_USER || '';
        this.outboxDir = path.resolve(env.EMAIL_OUTBOX_DIR ?? './outbox');

        const gmailReady = Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN && env.GMAIL_USER);
        const requested = env.EMAIL_DELIVERY ?? 'auto';
        if (requested === 'gmail' && !gmailReady) {
            console.warn('⚠️ EMAIL_DELIVERY=gmail but the Gmail OAuth2 values are incomplete. Falling back.');
        }
        this.delivery =
            (requested === 'gmail' || requested === 'auto') && gmailReady ? 'gmail'
            : requested === 'outbox' || (requested !== 'log' && env.NODE_ENV === 'development') ? 'outbox'
            : 'log';

        if (this.delivery === 'gmail') {
            const oauth2Client = new google.auth.OAuth2(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET);
            oauth2Client.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
            this.gmail = google.gmail({ version: 'v1', auth: oauth2Client });
            console.log('✅ Gmail API Email Service initialized (OAuth2)');
        } else if (this.delivery === 'outbox') {
            console.log(`📭 Email goes to the local outbox at ${this.outboxDir}`);
        } else {
            console.warn('⚠️ Gmail OAuth2 credentials not found. Emails are logged, not sent.');
        }
    }

    private buildRawMessage(to: string, subject: string, html: string): string {
        const messageParts = [
            `From: Avelon <${this.fromAddress}>`,
            `To: ${to}`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=utf-8',
            '',
            html,
        ];
        return Buffer.from(messageParts.join('\r\n')).toString('base64url');
    }

    /**
     * Send a raw HTML email.
     * @returns `true` on success, `false` if delivery failed (logged, not thrown).
     */
    async sendEmail(to: string, subject: string, html: string): Promise<boolean> {
        if (this.delivery === 'outbox') return this.writeToOutbox(to, subject, html);

        if (this.delivery === 'log' || !this.gmail) {
            console.log(`[STUB] Would have sent email to ${to}: ${subject}`);
            return true;
        }

        try {
            await this.gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw: this.buildRawMessage(to, subject, html) },
            });
            return true;
        } catch (error) {
            console.error('Email service error:', error);
            return false;
        }
    }

    private async writeToOutbox(to: string, subject: string, html: string): Promise<boolean> {
        try {
            await fs.mkdir(this.outboxDir, { recursive: true });
            // Sortable: time first, then a counter for messages in the same millisecond
            const id = `${Date.now()}-${String(this.outboxSeq++ % 10000).padStart(4, '0')}`;
            const meta: OutboxEntry = { id, to, subject, sentAt: new Date().toISOString() };
            await fs.writeFile(path.join(this.outboxDir, `${id}.html`), html);
            await fs.writeFile(path.join(this.outboxDir, `${id}.json`), JSON.stringify(meta));
            console.log(`[Outbox] ${to}: ${subject}`);
            return true;
        } catch (error) {
            console.error('[Outbox] Could not write email:', error);
            return false;
        }
    }

    /** Newest first. Only meaningful in outbox mode. */
    async listOutbox(limit = 50): Promise<OutboxEntry[]> {
        let files: string[];
        try {
            files = await fs.readdir(this.outboxDir);
        } catch {
            return [];
        }
        const metas = files.filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit);
        const entries = await Promise.all(
            metas.map(async (f) => JSON.parse(await fs.readFile(path.join(this.outboxDir, f), 'utf8')) as OutboxEntry),
        );
        return entries;
    }

    async readOutbox(id: string): Promise<string | null> {
        if (!/^[\w-]+$/.test(id)) return null;
        try {
            return await fs.readFile(path.join(this.outboxDir, `${id}.html`), 'utf8');
        } catch {
            return null;
        }
    }

    /** Send the 6-digit email verification code to a newly registered user. */
    async sendVerificationEmail(to: string, otp: string): Promise<boolean> {
        const html = renderEmail({
            preheader: `Your Avelon verification code is ${otp}`,
            heading: 'Welcome to Avelon',
            intro: 'Enter this 6-digit code in the app to verify your email address.',
            code: otp,
            note: 'This code will expire in 1 hour. If you did not create an Avelon account, ignore this email.',
        });
        return this.sendEmail(to, 'Verify your Avelon Account', html);
    }

    /** Send a password-reset code to an existing user. */
    async sendPasswordResetEmail(to: string, otp: string): Promise<boolean> {
        const html = renderEmail({
            preheader: `Your Avelon password reset code is ${otp}`,
            heading: 'Password Reset Request',
            intro: 'Enter this 6-digit code in the app to choose a new password.',
            code: otp,
            note: 'This code will expire in 1 hour. If you did not ask to reset your password, ignore this email. Your password stays the same.',
        });
        return this.sendEmail(to, 'Reset your Avelon Password', html);
    }
}

export const emailService = new EmailService();
