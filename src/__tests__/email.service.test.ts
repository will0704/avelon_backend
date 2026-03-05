import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Gmail API send method
const mockGmailSend = vi.fn();

vi.mock('googleapis', () => ({
    google: {
        auth: {
            OAuth2: class MockOAuth2 {
                setCredentials = vi.fn();
            },
        },
        gmail: vi.fn(() => ({
            users: {
                messages: {
                    send: mockGmailSend,
                },
            },
        })),
    },
}));

// Mock env with Gmail OAuth2 credentials
vi.mock('../config/env.js', () => ({
    env: {
        GMAIL_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
        GMAIL_CLIENT_SECRET: 'test-client-secret',
        GMAIL_REFRESH_TOKEN: 'test-refresh-token',
        GMAIL_USER: 'test@gmail.com',
    },
}));

describe('EmailService', () => {
    let emailService: typeof import('../services/email.service.js')['emailService'];

    beforeEach(async () => {
        vi.clearAllMocks();
        mockGmailSend.mockResolvedValue({ data: { id: 'msg-123' } });

        const mod = await import('../services/email.service.js');
        emailService = mod.emailService;
    });

    describe('sendEmail', () => {
        it('sends email via Gmail API with correct base64 message', async () => {
            const result = await emailService.sendEmail(
                'user@example.com',
                'Test Subject',
                '<p>Hello</p>'
            );

            expect(result).toBe(true);
            expect(mockGmailSend).toHaveBeenCalledTimes(1);

            const callArgs = mockGmailSend.mock.calls[0][0];
            expect(callArgs.userId).toBe('me');
            expect(callArgs.requestBody.raw).toBeDefined();

            // Decode the base64url raw message and verify headers
            const raw = callArgs.requestBody.raw;
            const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
            expect(decoded).toContain('To: user@example.com');
            expect(decoded).toContain('Subject: Test Subject');
            expect(decoded).toContain('From: Avelon <test@gmail.com>');
            expect(decoded).toContain('<p>Hello</p>');
        });

        it('returns false on API error', async () => {
            mockGmailSend.mockRejectedValueOnce(new Error('Gmail API error'));

            const result = await emailService.sendEmail(
                'user@example.com',
                'Test',
                '<p>Hi</p>'
            );

            expect(result).toBe(false);
        });
    });

    describe('sendVerificationEmail', () => {
        it('sends verification OTP with correct subject and content', async () => {
            const result = await emailService.sendVerificationEmail(
                'user@example.com',
                '123456'
            );

            expect(result).toBe(true);
            expect(mockGmailSend).toHaveBeenCalledTimes(1);

            const raw = mockGmailSend.mock.calls[0][0].requestBody.raw;
            const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
            expect(decoded).toContain('To: user@example.com');
            expect(decoded).toContain('Subject: Verify your Avelon Account');
            expect(decoded).toContain('123456');
            expect(decoded).toContain('Welcome to Avelon');
        });

        it('includes expiration notice in verification email', async () => {
            await emailService.sendVerificationEmail('user@example.com', '999999');

            const raw = mockGmailSend.mock.calls[0][0].requestBody.raw;
            const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
            expect(decoded).toContain('expire in 1 hour');
        });
    });

    describe('sendPasswordResetEmail', () => {
        it('sends password reset OTP with correct subject and content', async () => {
            const result = await emailService.sendPasswordResetEmail(
                'user@example.com',
                '654321'
            );

            expect(result).toBe(true);
            expect(mockGmailSend).toHaveBeenCalledTimes(1);

            const raw = mockGmailSend.mock.calls[0][0].requestBody.raw;
            const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
            expect(decoded).toContain('To: user@example.com');
            expect(decoded).toContain('Subject: Reset your Avelon Password');
            expect(decoded).toContain('654321');
            expect(decoded).toContain('Password Reset Request');
        });

        it('includes expiration notice in reset email', async () => {
            await emailService.sendPasswordResetEmail('user@example.com', '111111');

            const raw = mockGmailSend.mock.calls[0][0].requestBody.raw;
            const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
            expect(decoded).toContain('expire in 1 hour');
        });
    });
});

describe('EmailService (unconfigured)', () => {
    it('stubs email when OAuth2 credentials are missing', async () => {
        vi.resetModules();
        mockGmailSend.mockClear();

        vi.doMock('../config/env.js', () => ({
            env: {
                GMAIL_CLIENT_ID: undefined,
                GMAIL_CLIENT_SECRET: undefined,
                GMAIL_REFRESH_TOKEN: undefined,
                GMAIL_USER: undefined,
            },
        }));

        vi.doMock('googleapis', () => ({
            google: {
                auth: {
                    OAuth2: class MockOAuth2 {
                        setCredentials = vi.fn();
                    },
                },
                gmail: vi.fn(() => ({
                    users: {
                        messages: {
                            send: mockGmailSend,
                        },
                    },
                })),
            },
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
        expect(mockGmailSend).not.toHaveBeenCalled();
    });
});
