/**
 * Local dev must not need mail credentials: with Gmail unconfigured, email goes
 * to an outbox folder the admin demo page can list.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'avelon-outbox-'));

vi.mock('googleapis', () => ({ google: { auth: { OAuth2: class {} }, gmail: vi.fn() } }));
vi.mock('../config/env.js', () => ({
    env: { NODE_ENV: 'development', EMAIL_DELIVERY: 'auto', EMAIL_OUTBOX_DIR: dir },
}));

const { emailService } = await import('../services/email.service.js');

describe('outbox delivery', () => {
    beforeAll(async () => {
        await emailService.sendVerificationEmail('paolo.reyes@example.com', '482913');
        await emailService.sendEmail('maria.santos@example.com', 'Loan approved: deposit your stake', '<p>Hi</p>');
    });

    it('chooses the outbox in development when Gmail is not configured', () => {
        expect(emailService.delivery).toBe('outbox');
    });

    it('writes each email to disk and lists the newest first', async () => {
        const entries = await emailService.listOutbox();
        expect(entries.map((e) => e.to)).toEqual(['maria.santos@example.com', 'paolo.reyes@example.com']);
        expect(entries[1].subject).toBe('Verify your Avelon Account');
    });

    it('serves the stored HTML back by id', async () => {
        const [, verification] = await emailService.listOutbox();
        const html = await emailService.readOutbox(verification.id);
        expect(html).toContain('482913');
        expect(html).toContain('expire in 1 hour');
    });

    it('refuses ids that could walk out of the folder', async () => {
        expect(await emailService.readOutbox('../../etc/passwd')).toBeNull();
    });
});
