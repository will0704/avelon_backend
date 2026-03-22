/**
 * Critical Security Fixes — Verification Test Suite
 *
 * Verifies all 5 critical issues from code review round 2 are fixed:
 *
 * C-1: register() returns verificationToken; service does NOT self-send email
 * C-2: forgotPassword() returns token; service does NOT self-send email
 * C-3: POST /auth/login response sets an HttpOnly + SameSite=Strict cookie
 * C-4: POST /loans returns 500 before touching DB when COLLATERAL_MANAGER_ADDRESS unset
 * C-5: KYC upload rejects files with disallowed extensions (.exe, .pdf.exe, etc.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';

// MUST be first — registers Prisma mock before any module resolves
import './prisma.mock.js';
import { mockPrismaClient } from './prisma.mock.js';

// ── Module mocks (hoisted by Vitest) ────────────────────────────────────────

vi.mock('bcrypt', () => ({
    default: {
        hash: vi.fn().mockResolvedValue('$2b$12$hashedpassword'),
        compare: vi.fn().mockResolvedValue(true),
    },
}));

vi.mock('fs/promises', () => ({
    default: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
    },
}));

const { mockSendVerificationEmail, mockSendPasswordResetEmail } = vi.hoisted(() => ({
    mockSendVerificationEmail: vi.fn().mockResolvedValue(true),
    mockSendPasswordResetEmail: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services/email.service.js', () => ({
    emailService: {
        sendVerificationEmail: mockSendVerificationEmail,
        sendPasswordResetEmail: mockSendPasswordResetEmail,
        sendEmail: vi.fn().mockResolvedValue(true),
    },
}));

vi.mock('../config/env.js', () => ({
    env: {
        JWT_SECRET: 'test-secret-vitest-critical',
        JWT_ACCESS_EXPIRY: '15m',
        JWT_REFRESH_EXPIRY: '7d',
        NODE_ENV: 'test',
        TREASURY_ADDRESS: '0xTreasury',
        AVELON_LENDING_ADDRESS: '0xLending',
        COLLATERAL_MANAGER_ADDRESS: '0xCollateral',
        REPAYMENT_SCHEDULE_ADDRESS: '0xRepayment',
    },
}));

vi.mock('../middleware/rate-limit.middleware.js', () => ({
    isAccountLocked: vi.fn().mockReturnValue({ locked: false }),
    recordFailedLogin: vi.fn().mockReturnValue(false),
    resetLoginAttempts: vi.fn(),
    globalRateLimiter: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
    adminRateLimiter: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
    authRateLimiter: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
    createRateLimiter: vi.fn(() => (_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('../services/loan.service.js', () => ({
    loanService: {
        createLoan: vi.fn().mockResolvedValue({
            id: 'loan-test-123',
            collateralRequired: '0.04',
            amount: '0.5',
        }),
        calculateLoan: vi.fn(),
        extendLoan: vi.fn(),
        getLoan: vi.fn(),
        listLoans: vi.fn(),
        getLoanTransactions: vi.fn().mockResolvedValue([]),
    },
}));

vi.mock('../services/notification.service.js', () => ({
    notificationService: {
        notify: vi.fn().mockResolvedValue(undefined),
        sendPushNotification: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../services/blockchain.service.js', () => ({
    blockchainService: {
        getNetworkInfo: vi.fn().mockResolvedValue({ name: 'test', chainId: '1337' }),
        getBlockNumber: vi.fn().mockResolvedValue(0),
        isValidAddress: vi.fn().mockReturnValue(true),
    },
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { AuthService } from '../services/auth.service.js';
import { app } from '../app.js';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-vitest-critical';

const mockApprovedUser = {
    id: 'user-test-abc',
    email: 'test@example.com',
    name: 'Test User',
    role: 'BORROWER',
    status: 'APPROVED',
    passwordHash: '$2b$12$hashedpassword',
    emailVerified: new Date(),
    kycLevel: 'NONE',
    creditScore: 70,
    creditTier: 'FAIR',
    createdAt: new Date(),
    updatedAt: new Date(),
};

/** Returns Authorization header with a signed test JWT */
function authHeader(): Record<string, string> {
    const token = jwt.sign(
        {
            sub: mockApprovedUser.id,
            email: mockApprovedUser.email,
            role: mockApprovedUser.role,
            type: 'access',
        },
        JWT_SECRET,
        { expiresIn: '1h' }
    );
    return { Authorization: `Bearer ${token}` };
}

// ── C-1: register() returns verificationToken ────────────────────────────────

describe('C-1 — register() returns verificationToken', () => {
    let authService: AuthService;

    beforeEach(() => {
        vi.clearAllMocks();
        authService = new AuthService();
        mockPrismaClient.user.findUnique.mockResolvedValue(null);
        mockPrismaClient.user.create.mockResolvedValue({
            id: 'user-new-001',
            email: 'newuser@example.com',
            name: null,
            status: 'REGISTERED',
        });
    });

    it('result includes a 6-digit verificationToken', async () => {
        const result = await authService.register({
            email: 'newuser@example.com',
            password: 'TestPass1!',
        });

        expect(result.verificationToken).toBeDefined();
        expect(result.verificationToken).toMatch(/^\d{6}$/);
    });

    it('service does NOT call emailService.sendVerificationEmail directly', async () => {
        await authService.register({
            email: 'newuser@example.com',
            password: 'TestPass1!',
        });

        expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });

    it('result.user contains id, email, and status', async () => {
        const result = await authService.register({
            email: 'newuser@example.com',
            password: 'TestPass1!',
        });

        expect(result.user).toMatchObject({
            id: 'user-new-001',
            email: 'newuser@example.com',
            status: 'REGISTERED',
        });
    });
});

// ── C-2: forgotPassword() returns token ─────────────────────────────────────

describe('C-2 — forgotPassword() returns token', () => {
    let authService: AuthService;

    beforeEach(() => {
        vi.clearAllMocks();
        authService = new AuthService();
    });

    it('returns { success: true, token } when user exists', async () => {
        mockPrismaClient.user.findUnique.mockResolvedValue(mockApprovedUser);

        const result = await authService.forgotPassword('test@example.com');

        expect(result.success).toBe(true);
        expect(result.token).toMatch(/^\d{6}$/);
    });

    it('returns { success: true } with NO token when user does not exist (prevents email enumeration)', async () => {
        mockPrismaClient.user.findUnique.mockResolvedValue(null);

        const result = await authService.forgotPassword('ghost@example.com');

        expect(result.success).toBe(true);
        expect('token' in result).toBe(false);
    });

    it('service does NOT call emailService.sendPasswordResetEmail directly', async () => {
        mockPrismaClient.user.findUnique.mockResolvedValue(mockApprovedUser);

        await authService.forgotPassword('test@example.com');

        expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    });
});

// ── C-3: POST /auth/login sets HttpOnly cookie ───────────────────────────────

describe('C-3 — Login sets HttpOnly cookie', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPrismaClient.user.findUnique.mockResolvedValue(mockApprovedUser);
        mockPrismaClient.session.create.mockResolvedValue({ id: 'session-001' });
        mockPrismaClient.session.findFirst.mockResolvedValue(null);
    });

    it('login response includes a Set-Cookie header', async () => {
        const res = await app.request('/api/v1/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'test@example.com', password: 'TestPass1!' }),
        });

        expect(res.headers.get('set-cookie')).not.toBeNull();
    });

    it('Set-Cookie header includes HttpOnly flag', async () => {
        const res = await app.request('/api/v1/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'test@example.com', password: 'TestPass1!' }),
        });

        const cookie = res.headers.get('set-cookie') ?? '';
        expect(cookie.toLowerCase()).toContain('httponly');
    });

    it('Set-Cookie header includes SameSite=Strict', async () => {
        const res = await app.request('/api/v1/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'test@example.com', password: 'TestPass1!' }),
        });

        const cookie = res.headers.get('set-cookie') ?? '';
        expect(cookie.toLowerCase()).toContain('samesite=strict');
    });
});

// ── C-4: POST /loans → 500 when COLLATERAL_MANAGER_ADDRESS unset ─────────────

describe('C-4 — Missing COLLATERAL_MANAGER_ADDRESS env var', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPrismaClient.user.findUnique.mockResolvedValue(mockApprovedUser);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('returns 500 before creating loan when env var is not set', async () => {
        vi.stubEnv('COLLATERAL_MANAGER_ADDRESS', '');

        const res = await app.request('/api/v1/loans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader() },
            body: JSON.stringify({
                planId: 'plan-abc',
                amount: '0.5',
                duration: 30,
                walletId: 'wallet-abc',
            }),
        });

        expect(res.status).toBe(500);

        // Loan should NOT have been created — guard runs before createLoan
        const { loanService } = await import('../services/loan.service.js');
        expect(loanService.createLoan).not.toHaveBeenCalled();
    });

    it('returns 201 when COLLATERAL_MANAGER_ADDRESS is set', async () => {
        vi.stubEnv('COLLATERAL_MANAGER_ADDRESS', '0xValidAddress');

        const res = await app.request('/api/v1/loans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader() },
            body: JSON.stringify({
                planId: 'plan-abc',
                amount: '0.5',
                duration: 30,
                walletId: 'wallet-abc',
            }),
        });

        expect(res.status).toBe(201);
    });
});

// ── C-5: KYC upload rejects disallowed extensions ────────────────────────────

describe('C-5 — File extension whitelist', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPrismaClient.user.findUnique.mockResolvedValue(mockApprovedUser);
        mockPrismaClient.document.findFirst.mockResolvedValue(null);
    });

    it('rejects a .exe file (MIME-type spoofed as image/jpeg)', async () => {
        const file = new File(['fake-binary'], 'passport.exe', { type: 'image/jpeg' });
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', 'GOVERNMENT_ID');

        const res = await app.request('/api/v1/kyc/documents', {
            method: 'POST',
            headers: authHeader(),
            body: formData,
        });

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.success).toBe(false);
        expect(data.error.message).toContain('File type not allowed');
    });

    it('rejects a .pdf.exe double-extension file', async () => {
        const file = new File(['fake-binary'], 'passport.pdf.exe', { type: 'image/jpeg' });
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', 'GOVERNMENT_ID');

        const res = await app.request('/api/v1/kyc/documents', {
            method: 'POST',
            headers: authHeader(),
            body: formData,
        });

        expect(res.status).toBe(400);
    });

    it('accepts a legitimate .jpg file without rejecting', async () => {
        const file = new File(['fake-jpeg-data'], 'passport.jpg', { type: 'image/jpeg' });
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', 'GOVERNMENT_ID');

        const res = await app.request('/api/v1/kyc/documents', {
            method: 'POST',
            headers: authHeader(),
            body: formData,
        });

        // Must not be rejected by the extension whitelist
        expect(res.status).not.toBe(400);
    });

    it('accepts a legitimate .pdf file without rejecting', async () => {
        const file = new File(['%PDF-1.4 fake'], 'income_proof.pdf', {
            type: 'application/pdf',
        });
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', 'PROOF_OF_INCOME');

        const res = await app.request('/api/v1/kyc/documents', {
            method: 'POST',
            headers: authHeader(),
            body: formData,
        });

        expect(res.status).not.toBe(400);
    });
});
