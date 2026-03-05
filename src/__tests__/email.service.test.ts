import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock nodemailer before importing the service
const mockSendMail = vi.fn();
const mockCreateTransport = vi.fn(() => ({
    sendMail: mockSendMail,
    verify: vi.fn().mockResolvedValue(true),
}));

vi.mock('nodemailer', () => ({
    default: { createTransport: mockCreateTransport },
    createTransport: mockCreateTransport,
}));

// Mock env
vi.mock('../config/env.js', () => ({
    env: {
        GMAIL_USER: 'test@gmail.com',
        GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
        EMAIL_FROM: 'test@gmail.com',
    },
}));

describe('EmailService', () => {
    let emailService: typeof import('../services/email.service.js')['emailService'];

    beforeEach(async () => {
        vi.clearAllMocks();
        mockSendMail.mockResolvedValue({ messageId: '<test-id>' });

        // Re-import to get fresh instance
        const mod = await import('../services/email.service.js');
        emailService = mod.emailService;
    });

    describe('sendEmail', () => {
        it('sends email with correct parameters', async () => {
            const result = await emailService.sendEmail(
                'user@example.com',
                'Test Subject',
                '<p>Hello</p>'
            );

            expect(result).toBe(true);
            expect(mockSendMail).toHaveBeenCalledWith({
                from: '"Avelon" <test@gmail.com>',
                to: 'user@example.com',
                subject: 'Test Subject',
                html: '<p>Hello</p>',
            });
        });

        it('returns false on send failure', async () => {
            mockSendMail.mockRejectedValueOnce(new Error('SMTP error'));

            const result = await emailService.sendEmail(
                'user@example.com',
                'Test',
                '<p>Hi</p>'
            );

            expect(result).toBe(false);
        });
    });

    describe('sendVerificationEmail', () => {
        it('sends verification OTP with correct subject', async () => {
            const result = await emailService.sendVerificationEmail(
                'user@example.com',
                '123456'
            );

            expect(result).toBe(true);
            expect(mockSendMail).toHaveBeenCalledTimes(1);

            const callArgs = mockSendMail.mock.calls[0][0];
            expect(callArgs.to).toBe('user@example.com');
            expect(callArgs.subject).toBe('Verify your Avelon Account');
            expect(callArgs.html).toContain('123456');
            expect(callArgs.html).toContain('Welcome to Avelon');
        });

        it('includes expiration notice in verification email', async () => {
            await emailService.sendVerificationEmail('user@example.com', '999999');

            const callArgs = mockSendMail.mock.calls[0][0];
            expect(callArgs.html).toContain('expire in 1 hour');
        });
    });

    describe('sendPasswordResetEmail', () => {
        it('sends password reset OTP with correct subject', async () => {
            const result = await emailService.sendPasswordResetEmail(
                'user@example.com',
                '654321'
            );

            expect(result).toBe(true);
            expect(mockSendMail).toHaveBeenCalledTimes(1);

            const callArgs = mockSendMail.mock.calls[0][0];
            expect(callArgs.to).toBe('user@example.com');
            expect(callArgs.subject).toBe('Reset your Avelon Password');
            expect(callArgs.html).toContain('654321');
            expect(callArgs.html).toContain('Password Reset Request');
        });

        it('includes expiration notice in reset email', async () => {
            await emailService.sendPasswordResetEmail('user@example.com', '111111');

            const callArgs = mockSendMail.mock.calls[0][0];
            expect(callArgs.html).toContain('expire in 1 hour');
        });
    });
});

describe('EmailService (unconfigured)', () => {
    it('stubs email when credentials are missing', async () => {
        // Reset modules to re-evaluate with missing credentials
        vi.resetModules();
        mockSendMail.mockClear();

        vi.doMock('../config/env.js', () => ({
            env: {
                GMAIL_USER: undefined,
                GMAIL_APP_PASSWORD: undefined,
                EMAIL_FROM: 'noreply@avelon.finance',
            },
        }));

        vi.doMock('nodemailer', () => ({
            default: { createTransport: mockCreateTransport },
            createTransport: mockCreateTransport,
        }));

        const { emailService: unconfiguredService } = await import(
            '../services/email.service.js'
        );

        const result = await unconfiguredService.sendEmail(
            'user@example.com',
            'Test',
            '<p>Hi</p>'
        );

        expect(result).toBe(true); // stub returns true
        expect(mockSendMail).not.toHaveBeenCalled();
    });
});
