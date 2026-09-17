/**
 * Account, KYC and admin rules: getting a new code, suspension, wallet removal,
 * account deletion, KYC submission and plan settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

import './prisma.mock.js';
import { mockPrismaClient } from './prisma.mock.js';

vi.mock('bcrypt', () => ({
    default: { hash: vi.fn().mockResolvedValue('$2b$hash'), compare: vi.fn().mockResolvedValue(true) },
}));

const fsMocks = vi.hoisted(() => ({ unlink: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rm: vi.fn() }));
vi.mock('fs/promises', () => ({ default: fsMocks }));

vi.mock('../config/env.js', () => ({
    corsAllowedOrigins: ['http://localhost'],
    exposeDemoOtp: false,
    isLocalOnly: false,
    chain: { id: 31337, minConfirmations: 1, rpcUrl: 'http://127.0.0.1:8545' },
    env: {
        JWT_SECRET: 'test-secret-account-routes',
        JWT_ACCESS_EXPIRY: '15m',
        JWT_REFRESH_EXPIRY: '7d',
        NODE_ENV: 'test',
        KYC_STORAGE_MODE: 'local',
        STORAGE_PATH: './uploads-test',
        TRUSTED_PROXY_COUNT: 0,
        RATE_LIMIT_GLOBAL_MAX: 1000,
        MIN_COLLATERAL_RATIO: 30,
    },
}));

vi.mock('../middleware/rate-limit.middleware.js', () => {
    const pass = (_c: unknown, next: () => Promise<void>) => next();
    return {
        isAccountLocked: vi.fn().mockResolvedValue({ locked: false }),
        recordFailedLogin: vi.fn(),
        resetLoginAttempts: vi.fn(),
        globalRateLimiter: pass,
        adminRateLimiter: pass,
        authRateLimiter: pass,
        rpcRateLimiter: pass,
        createRateLimiter: () => pass,
    };
});

const email = vi.hoisted(() => ({ sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn(), sendEmail: vi.fn() }));
vi.mock('../services/email.service.js', () => ({ emailService: email }));

const notify = vi.hoisted(() => vi.fn());
vi.mock('../services/notification.service.js', () => ({ notificationService: { notify } }));

const kycAi = vi.hoisted(() => ({ triggerAIVerification: vi.fn(), verifyFace: vi.fn(), recoverStalledKyc: vi.fn() }));
vi.mock('../services/kyc-verification.service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/kyc-verification.service.js')>()),
    ...kycAi,
}));

const { app } = await import('../app.js');
const { AuthService } = await import('../services/auth.service.js');
const { walletService } = await import('../services/wallet.service.js');
const { Prisma } = await import('../generated/prisma/client.js');

const SECRET = 'test-secret-account-routes';
let currentUser: Record<string, unknown>;

function call(method: string, path: string, body?: unknown) {
    const token = jwt.sign({ userId: currentUser.id, type: 'access', jti: 'j1' }, SECRET, { expiresIn: '15m' });
    return app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

function publicCall(path: string, body: unknown) {
    return app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    const m = mockPrismaClient as any;
    currentUser = { id: 'admin1', email: 'admin@test.com', role: 'ADMIN', status: 'APPROVED' };
    m.session = { findFirst: vi.fn().mockResolvedValue({ id: 's1' }), deleteMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn() };
    m.user = {
        findUnique: vi.fn().mockImplementation(({ where }) =>
            Promise.resolve(where.id === currentUser.id ? currentUser : null)),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({ id: 'new-user', email: 'new@test.com', name: null, status: 'REGISTERED' }),
    };
    m.verificationToken = {
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(null),
        delete: vi.fn(),
    };
    m.auditLog = { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) };
    m.wallet = {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn().mockResolvedValue(0),
    };
    m.loan = { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) };
    m.document = {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    m.loanPlan = { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) };
    m.systemConfig = { upsert: vi.fn().mockResolvedValue({}), findUnique: vi.fn() };
    m.priceHistory = { create: vi.fn().mockResolvedValue({}) };
    m.$transaction = vi.fn().mockImplementation((arg: unknown) =>
        typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(m) : Promise.all(arg as unknown[]));
    email.sendVerificationEmail.mockResolvedValue(true);
    notify.mockResolvedValue(undefined);
    kycAi.triggerAIVerification.mockResolvedValue(undefined);
});

// ─── verification codes ─────────────────────────────────────────────────

describe('getting a new verification code', () => {
    it('sends a fresh code to an unverified account and retires the old one', async () => {
        mockPrismaClient.user.findUnique = vi.fn().mockResolvedValue({ id: 'u1', email: 'new@test.com', status: 'REGISTERED' });

        const res = await publicCall('/api/v1/auth/resend-verification', { email: 'New@Test.com' });

        expect(res.status).toBe(200);
        expect(mockPrismaClient.verificationToken.deleteMany).toHaveBeenCalledWith({
            where: { identifier: 'new@test.com', type: 'EMAIL_VERIFICATION' },
        });
        expect(email.sendVerificationEmail).toHaveBeenCalledWith('new@test.com', expect.stringMatching(/^\d{6}$/));
    });

    it.each([
        ['an unknown email', null],
        ['an already verified account', { id: 'u2', email: 'done@test.com', status: 'VERIFIED' }],
    ])('answers the same way for %s without sending anything', async (_label, user) => {
        mockPrismaClient.user.findUnique = vi.fn().mockResolvedValue(user);

        const res = await publicCall('/api/v1/auth/resend-verification', { email: 'someone@test.com' });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.message).toMatch(/if an unverified account/i);
        expect(email.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it('picks another code when the first one collides with a live code', async () => {
        const collision = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 't' });
        mockPrismaClient.verificationToken.create = vi.fn()
            .mockRejectedValueOnce(collision)
            .mockResolvedValueOnce({});

        const result = await new AuthService().register({ email: 'new@test.com', password: 'Str0ng!pass' } as never);

        expect(mockPrismaClient.verificationToken.create).toHaveBeenCalledTimes(2);
        expect(result.verificationToken).toMatch(/^\d{6}$/);
    });
});

// ─── suspension ─────────────────────────────────────────────────────────

describe('suspending and restoring a user', () => {
    const borrower = { id: 'u5', email: 'b@test.com', role: 'BORROWER', status: 'CONNECTED' };

    beforeEach(() => {
        mockPrismaClient.user.findUnique = vi.fn().mockImplementation(({ where }) =>
            Promise.resolve(where.id === currentUser.id ? currentUser : where.id === borrower.id ? borrower : null));
    });

    it('suspends, signs the user out, and remembers the previous status', async () => {
        const res = await call('PUT', '/api/v1/admin/users/u5/status', { status: 'SUSPENDED' });

        expect(res.status).toBe(200);
        expect(mockPrismaClient.user.update).toHaveBeenCalledWith({ where: { id: 'u5' }, data: { status: 'SUSPENDED' } });
        expect(mockPrismaClient.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u5' } });
        expect(mockPrismaClient.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'USER_SUSPENDED',
                entityId: 'u5',
                metadata: expect.objectContaining({ previousStatus: 'CONNECTED', by: 'admin1' }),
            }),
        });
    });

    it('restores the status the user had before', async () => {
        borrower.status = 'SUSPENDED';
        mockPrismaClient.auditLog.findFirst = vi.fn().mockResolvedValue({ metadata: { previousStatus: 'VERIFIED' } });

        const res = await call('PUT', '/api/v1/admin/users/u5/status', { status: 'RESTORED' });

        expect(res.status).toBe(200);
        expect(mockPrismaClient.user.update).toHaveBeenCalledWith({ where: { id: 'u5' }, data: { status: 'VERIFIED' } });
        borrower.status = 'CONNECTED';
    });

    it('does not resume a verification that was in progress', async () => {
        borrower.status = 'SUSPENDED';
        mockPrismaClient.auditLog.findFirst = vi.fn().mockResolvedValue({ metadata: { previousStatus: 'PENDING_KYC' } });

        await call('PUT', '/api/v1/admin/users/u5/status', { status: 'RESTORED' });

        expect(mockPrismaClient.user.update).toHaveBeenCalledWith({ where: { id: 'u5' }, data: { status: 'VERIFIED' } });
        borrower.status = 'CONNECTED';
    });

    it.each(['APPROVED', 'CONNECTED', 'REGISTERED', 'bogus'])('refuses to set %s directly', async (status) => {
        const res = await call('PUT', '/api/v1/admin/users/u5/status', { status });
        expect(res.status).toBe(400);
        expect(mockPrismaClient.user.update).not.toHaveBeenCalled();
    });

    it('will not let an admin suspend themselves', async () => {
        const res = await call('PUT', '/api/v1/admin/users/admin1/status', { status: 'SUSPENDED' });
        expect(res.status).toBe(400);
    });

    it('refuses a body that is not JSON', async () => {
        const token = jwt.sign({ userId: 'admin1', type: 'access', jti: 'j1' }, SECRET);
        const res = await app.request('/api/v1/admin/users/u5/status', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: '{',
        });
        expect(res.status).toBe(400);
    });
});

// ─── wallets ────────────────────────────────────────────────────────────

describe('removing a wallet', () => {
    it('keeps a wallet that any loan points to', async () => {
        mockPrismaClient.wallet.findFirst = vi.fn().mockResolvedValue({ id: 'w1', userId: 'u1', address: '0xabc', isPrimary: false });
        mockPrismaClient.loan.count = vi.fn().mockResolvedValue(1);

        await expect(walletService.removeWallet('u1', 'w1')).rejects.toThrow(/loan history/);
        expect(mockPrismaClient.loan.count).toHaveBeenCalledWith({ where: { walletId: 'w1' } });
        expect(mockPrismaClient.wallet.delete).not.toHaveBeenCalled();
    });

    it('promotes another wallet when the primary one is removed', async () => {
        mockPrismaClient.wallet.findFirst = vi.fn()
            .mockResolvedValueOnce({ id: 'w1', userId: 'u1', address: '0xabc', isPrimary: true })
            .mockResolvedValueOnce({ id: 'w2', userId: 'u1', address: '0xdef', isPrimary: false });

        await walletService.removeWallet('u1', 'w1');

        expect(mockPrismaClient.wallet.update).toHaveBeenCalledWith({ where: { id: 'w2' }, data: { isPrimary: true } });
    });
});

// ─── account deletion ───────────────────────────────────────────────────

describe('deleting an account', () => {
    beforeEach(() => {
        currentUser = { id: 'u1', email: 'u1@test.com', role: 'BORROWER', status: 'CONNECTED' };
    });

    it('refuses while an application is under review', async () => {
        mockPrismaClient.loan.count = vi.fn().mockImplementation(({ where }) =>
            Promise.resolve(where.status.in.includes('PENDING_APPROVAL') ? 1 : 0));

        const res = await call('DELETE', '/api/v1/users/me');

        expect(res.status).toBe(400);
        expect(mockPrismaClient.user.update).not.toHaveBeenCalled();
    });

    it('erases personal data and KYC files and frees the wallets', async () => {
        mockPrismaClient.document.findMany = vi.fn().mockResolvedValue([
            { id: 'd1', storagePath: '/uploads/kyc/u1/GOVERNMENT_ID_1.jpg' },
        ]);
        mockPrismaClient.wallet.findMany = vi.fn().mockResolvedValue([{ id: 'w1', address: '0xabc' }]);

        const res = await call('DELETE', '/api/v1/users/me');
        expect(res.status).toBe(200);

        const data = mockPrismaClient.user.update.mock.calls[0][0].data;
        for (const field of [
            'name', 'phone', 'avatar', 'passwordHash', 'legalName', 'address', 'monthlyIncome', 'dateOfBirth',
            'birthDate', 'gender', 'civilStatus', 'educationLevel', 'country', 'region', 'province', 'cityTown',
            'barangay', 'contactNumber', 'secondaryEmail', 'idType', 'employmentType',
        ]) {
            expect(data, field).toHaveProperty(field);
            expect(data[field] === null || data[field] === 'Deleted User', field).toBe(true);
        }
        expect(fsMocks.unlink).toHaveBeenCalledWith('/uploads/kyc/u1/GOVERNMENT_ID_1.jpg');
        expect(mockPrismaClient.document.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
        expect(mockPrismaClient.wallet.update).toHaveBeenCalledWith({
            where: { id: 'w1' },
            data: { address: 'deleted:w1', isVerified: false, isPrimary: false },
        });
    });
});

// ─── KYC submission ─────────────────────────────────────────────────────

describe('submitting KYC', () => {
    beforeEach(() => {
        currentUser = { id: 'u1', email: 'u1@test.com', role: 'BORROWER', status: 'VERIFIED' };
        mockPrismaClient.document.findMany = vi.fn().mockResolvedValue([
            { id: 'id-2', type: 'GOVERNMENT_ID', storagePath: '/a.jpg', fileName: 'a.jpg' },
        ]);
    });

    it('starts verification once when two submissions race', async () => {
        mockPrismaClient.document.findFirst = vi.fn().mockResolvedValue({ faceMatchPassed: true, aiExtractedData: { comparedWithDocumentId: 'id-2' } });
        mockPrismaClient.user.updateMany = vi.fn().mockResolvedValue({ count: 0 });

        const res = await call('POST', '/api/v1/kyc/submit', {});

        expect(res.status).toBe(409);
        expect(kycAi.triggerAIVerification).not.toHaveBeenCalled();
    });

    it('asks for a new face match when the ID changed after the last one', async () => {
        mockPrismaClient.document.findFirst = vi.fn().mockResolvedValue({ faceMatchPassed: true, aiExtractedData: { comparedWithDocumentId: 'id-1' } });

        const res = await call('POST', '/api/v1/kyc/submit', {});
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error.message).toMatch(/face verification again/i);
        expect(kycAi.triggerAIVerification).not.toHaveBeenCalled();
    });

    it('submits when the face match belongs to the current ID', async () => {
        mockPrismaClient.document.findFirst = vi.fn().mockResolvedValue({ faceMatchPassed: true, aiExtractedData: { comparedWithDocumentId: 'id-2' } });

        const res = await call('POST', '/api/v1/kyc/submit', {});

        expect(res.status).toBe(200);
        expect(mockPrismaClient.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'u1', status: { in: ['VERIFIED', 'REJECTED'] } },
        }));
        expect(kycAi.triggerAIVerification).toHaveBeenCalledTimes(1);
    });
});

// ─── admin KYC decisions ────────────────────────────────────────────────

describe('admin KYC decisions', () => {
    beforeEach(() => {
        mockPrismaClient.user.findUnique = vi.fn().mockImplementation(({ where }) =>
            Promise.resolve(where.id === 'admin1' ? currentUser : { id: 'u7', status: 'PENDING_KYC', email: 'u7@test.com' }));
        (mockPrismaClient as any).document.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    });

    it('lets only one decision through', async () => {
        mockPrismaClient.user.updateMany = vi.fn().mockResolvedValue({ count: 0 });

        const res = await call('PUT', '/api/v1/admin/kyc/u7/approve', { creditScore: 70, tier: 'STANDARD' });

        expect(res.status).toBe(409);
        expect(notify).not.toHaveBeenCalled();
    });

    it('derives the tier from the score instead of trusting the form', async () => {
        mockPrismaClient.user.findUnique = vi.fn().mockImplementation(({ where, select }) =>
            Promise.resolve(where.id === 'admin1' ? currentUser : select?.kycLevel
                ? { id: 'u7', status: 'APPROVED', creditScore: 65, creditTier: 'STANDARD' }
                : { id: 'u7', status: 'PENDING_KYC', email: 'u7@test.com' }));

        const res = await call('PUT', '/api/v1/admin/kyc/u7/approve', { creditScore: 65, tier: 'VIP' });

        expect(res.status).toBe(200);
        expect(mockPrismaClient.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'u7', status: 'PENDING_KYC' },
            data: expect.objectContaining({ creditScore: 65, creditTier: 'STANDARD' }),
        }));
    });
});

// ─── plans and prices ───────────────────────────────────────────────────

describe('plan and price settings', () => {
    const validPlan = {
        name: 'Test', minCreditScore: 30, minAmount: '0.01', maxAmount: '0.1', durationOptions: [7, 30],
        interestRate: 8, collateralRatio: 60, originationFee: 2,
    };

    it.each([
        ['a rate finer than a basis point', { interestRate: 12.345 }],
        ['a fee that takes the whole principal', { originationFee: 100 }],
        ['an amount finer than a wei', { minAmount: '0.0000000000000000001' }],
    ])('refuses %s', async (_label, change) => {
        const res = await call('POST', '/api/v1/admin/plans', { ...validPlan, ...change });
        expect(res.status).toBe(400);
        expect(mockPrismaClient.loanPlan.create).not.toHaveBeenCalled();
    });

    it('checks a partial update against the stored amounts', async () => {
        mockPrismaClient.loanPlan.findUnique = vi.fn().mockResolvedValue({
            id: 'p1', minAmount: { toString: () => '0.05' }, maxAmount: { toString: () => '0.5' },
            durationOptions: [30], extensionAllowed: false, maxExtensionDays: 0, extensionFee: 0,
        });
        const res = await call('PUT', '/api/v1/admin/plans/p1', { maxAmount: '0.01' });
        expect(res.status).toBe(400);
        expect(mockPrismaClient.loanPlan.update).not.toHaveBeenCalled();
    });

    it('records who created a plan', async () => {
        mockPrismaClient.loanPlan.create = vi.fn().mockResolvedValue({
            id: 'p9', ...validPlan, minAmount: 0.01, maxAmount: 0.1, _count: { loans: 0 },
        });
        const res = await call('POST', '/api/v1/admin/plans', validPlan);
        expect(res.status).toBe(201);
        expect(mockPrismaClient.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'PLAN_CREATED', userId: 'admin1', entityId: 'p9' }),
        });
    });

    it('records who changed the ETH price', async () => {
        const res = await call('POST', '/api/v1/admin/price', { price: 150000 });
        expect(res.status).toBe(200);
        expect(mockPrismaClient.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'PRICE_UPDATED', userId: 'admin1' }),
        });
    });
});
