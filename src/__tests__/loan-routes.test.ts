/**
 * HTTP-level rules for loans and admin loan actions: what each route hands to
 * the service, what it refuses before the service runs, and who may call it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

import './prisma.mock.js';
import { mockPrismaClient } from './prisma.mock.js';

vi.mock('../config/env.js', () => ({
    corsAllowedOrigins: ['http://localhost'],
    exposeDemoOtp: false,
    chain: { id: 31337, minConfirmations: 1, rpcUrl: 'http://127.0.0.1:8545' },
    env: {
        JWT_SECRET: 'test-secret-loan-routes',
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

const loanMocks = vi.hoisted(() => ({
    createLoan: vi.fn(),
    recordCollateralDeposit: vi.fn(),
    recordAdditionalCollateral: vi.fn(),
    recordRepayment: vi.fn(),
    cancelLoan: vi.fn(),
    liquidateLoan: vi.fn(),
    retryDisbursement: vi.fn(),
    completeRepaidLoan: vi.fn(),
    settleLiquidation: vi.fn(),
    approveLoan: vi.fn(),
    rejectLoan: vi.fn(),
}));
vi.mock('../services/loan.service.js', () => ({ loanService: loanMocks }));

vi.mock('../services/notification.service.js', () => ({
    notificationService: { notify: vi.fn().mockResolvedValue(undefined) },
}));

const chainStatus = vi.hoisted(() => ({
    getNetworkInfo: vi.fn().mockResolvedValue({ name: 'hardhat', chainId: 31337 }),
    getBlockNumber: vi.fn().mockResolvedValue(12),
    hasContractCode: vi.fn(),
}));
vi.mock('../services/blockchain.service.js', () => ({ blockchainService: chainStatus }));

vi.mock('../services/email.service.js', () => ({
    emailService: { sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn(), sendEmail: vi.fn() },
}));

const { app } = await import('../app.js');
const { NotFoundError } = await import('../middleware/error.middleware.js');

const SECRET = 'test-secret-loan-routes';
const HASH = '0x' + 'cd'.repeat(32);

function tokenFor(userId: string) {
    return jwt.sign({ userId, email: `${userId}@test.com`, role: 'X', type: 'access', jti: 'jti-1' }, SECRET, { expiresIn: '15m' });
}

let currentUser = { id: 'borrower1', email: 'b@test.com', role: 'BORROWER', status: 'CONNECTED' };

function call(method: string, path: string, body?: unknown) {
    return app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(currentUser.id)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('COLLATERAL_MANAGER_ADDRESS', '0xcm');
    currentUser = { id: 'borrower1', email: 'b@test.com', role: 'BORROWER', status: 'CONNECTED' };
    mockPrismaClient.session.findFirst = vi.fn().mockResolvedValue({ id: 's1' });
    mockPrismaClient.user.findUnique = vi.fn().mockImplementation(() => Promise.resolve(currentUser));
});

describe('borrower loan routes', () => {
    it.each(['0.', '.5', '1e-2', '-1', '0.0100000000000000001'])('refuses the amount %s', async (amount) => {
        const res = await call('POST', '/api/v1/loans', {
            planId: 'p1', amount, duration: 30, walletId: 'w1', purpose: 'School fees',
        });
        expect(res.status).toBe(400);
        expect(loanMocks.createLoan).not.toHaveBeenCalled();
    });

    it('keeps the status of a service error behind the auth check', async () => {
        loanMocks.createLoan.mockRejectedValueOnce(new NotFoundError('Loan plan not found or inactive'));
        const res = await call('POST', '/api/v1/loans', {
            planId: 'missing', amount: '0.05', duration: 30, walletId: 'w1', purpose: 'School fees',
        });
        expect(res.status).toBe(404);
    });

    it('tells the borrower when the payout is still pending', async () => {
        loanMocks.recordCollateralDeposit.mockResolvedValue({
            success: true,
            payoutPending: true,
            loan: { id: 'l1', status: 'COLLATERAL_DEPOSITED', collateralDeposited: '0.03', collateralRequired: '0.03' },
        });

        const res = await call('POST', '/api/v1/loans/l1/collateral', { txHash: HASH });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.payoutPending).toBe(true);
        expect(body.message).toMatch(/payout/i);
    });

    it('records a stake top-up through the top-up flow', async () => {
        loanMocks.recordAdditionalCollateral.mockResolvedValue({ success: true, loan: { id: 'l1', collateralDeposited: '0.04' } });

        const res = await call('POST', '/api/v1/loans/l1/add-collateral', { txHash: HASH });

        expect(res.status).toBe(200);
        expect(loanMocks.recordAdditionalCollateral).toHaveBeenCalledWith('l1', 'borrower1', HASH);
        expect(loanMocks.recordCollateralDeposit).not.toHaveBeenCalled();
    });

    it('reports a paid-off loan whose stake is still being released', async () => {
        loanMocks.recordRepayment.mockResolvedValue({ success: true, remainingOwed: '0', collateralReleasePending: true });

        const res = await call('POST', '/api/v1/loans/l1/repay', { amount: '0.05', txHash: HASH });
        const body = await res.json();

        expect(body.data.isFullyRepaid).toBe(true);
        expect(body.data.collateralReleasePending).toBe(true);
    });
});

describe('chain status', () => {
    it('says when the contracts are missing, as after a node restart', async () => {
        vi.stubEnv('AVELON_LENDING_ADDRESS', '0xlending');
        vi.stubEnv('LIQUIDITY_POOL_ADDRESS', '0xpool');
        chainStatus.hasContractCode.mockImplementation(async (address: string) => address !== '0xpool');

        const body = await (await call('GET', '/api/v1/loans/blockchain/status')).json();

        expect(body.data.connected).toBe(true);
        expect(body.data.contractsDeployed).toBe(false);
    });

    it('says when every contract is in place', async () => {
        chainStatus.hasContractCode.mockResolvedValue(true);
        const body = await (await call('GET', '/api/v1/loans/blockchain/status')).json();
        expect(body.data.contractsDeployed).toBe(true);
    });
});

describe('admin loan routes', () => {
    beforeEach(() => {
        currentUser = { id: 'admin1', email: 'a@test.com', role: 'ADMIN', status: 'APPROVED' };
    });

    it('passes the requested liquidation reason to the service', async () => {
        loanMocks.liquidateLoan.mockResolvedValue({ txHash: '0x1', settlementPending: false });
        const res = await call('POST', '/api/v1/admin/loans/l1/liquidate', { reason: 'SHORTFALL' });
        expect(res.status).toBe(200);
        expect(loanMocks.liquidateLoan).toHaveBeenCalledWith('l1', 'admin1', 'SHORTFALL');
    });

    it('retries a pending payout', async () => {
        loanMocks.retryDisbursement.mockResolvedValue({ id: 'l1', status: 'ACTIVE' });
        const res = await call('POST', '/api/v1/admin/loans/l1/disburse');
        expect(res.status).toBe(200);
        expect(loanMocks.retryDisbursement).toHaveBeenCalledWith('l1');
    });

    it('finishes a paid-off loan', async () => {
        loanMocks.completeRepaidLoan.mockResolvedValue({ id: 'l1', status: 'REPAID' });
        const res = await call('POST', '/api/v1/admin/loans/l1/release-collateral');
        expect(res.status).toBe(200);
        expect(loanMocks.completeRepaidLoan).toHaveBeenCalledWith('l1');
    });

    it('retries liquidation settlement', async () => {
        loanMocks.settleLiquidation.mockResolvedValue({ settlementPending: false });
        const res = await call('POST', '/api/v1/admin/loans/l1/settle');
        expect(res.status).toBe(200);
        expect(loanMocks.settleLiquidation).toHaveBeenCalledWith('l1', 'admin1');
    });

    it('refuses a rejection whose body is not JSON', async () => {
        const res = await app.request('/api/v1/admin/loans/l1/reject', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor('admin1')}` },
            body: 'not json',
        });
        expect(res.status).toBe(400);
        expect(loanMocks.rejectLoan).not.toHaveBeenCalled();
    });
});

describe('admin routes refuse other roles', () => {
    const adminCalls: [string, string][] = [
        ['GET', '/api/v1/admin/users'],
        ['PUT', '/api/v1/admin/users/u2/status'],
        ['GET', '/api/v1/admin/loans'],
        ['POST', '/api/v1/admin/loans/l1/approve'],
        ['POST', '/api/v1/admin/loans/l1/liquidate'],
        ['POST', '/api/v1/admin/loans/l1/disburse'],
        ['GET', '/api/v1/admin/kyc/pending'],
        ['PUT', '/api/v1/admin/kyc/u2/approve'],
        ['POST', '/api/v1/admin/plans'],
        ['POST', '/api/v1/admin/price'],
        ['GET', '/api/v1/admin/audit-logs'],
        ['GET', '/api/v1/admin/treasury'],
    ];

    it.each(['BORROWER', 'INVESTOR'])('returns 403 to a %s on every admin route', async (role) => {
        currentUser = { id: 'u9', email: 'u9@test.com', role, status: 'APPROVED' };
        for (const [method, path] of adminCalls) {
            const res = await call(method, path, method === 'GET' ? undefined : {});
            expect(res.status, `${method} ${path}`).toBe(403);
        }
        expect(loanMocks.approveLoan).not.toHaveBeenCalled();
        expect(loanMocks.liquidateLoan).not.toHaveBeenCalled();
    });
});
