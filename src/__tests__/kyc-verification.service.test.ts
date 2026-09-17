import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFsReadFile = vi.fn();
const mockFsUnlink = vi.fn();
vi.mock('fs/promises', () => ({
    default: {
        readFile: (...args: unknown[]) => mockFsReadFile(...args),
        unlink: (...args: unknown[]) => mockFsUnlink(...args),
    },
}));

const mockDocUpdate = vi.fn();
const mockDocUpdateMany = vi.fn();
const mockDocCreate = vi.fn();
const mockDocFindFirst = vi.fn();
const mockUserUpdate = vi.fn();
const mockUserFindUnique = vi.fn();
const mockUserFindMany = vi.fn();
const mockWalletFindFirst = vi.fn();
const mockAuditCreate = vi.fn();
vi.mock('../lib/prisma.js', () => ({
    prisma: {
        document: {
            update: (...args: unknown[]) => mockDocUpdate(...args),
            updateMany: (...args: unknown[]) => mockDocUpdateMany(...args),
            create: (...args: unknown[]) => mockDocCreate(...args),
            findFirst: (...args: unknown[]) => mockDocFindFirst(...args),
        },
        user: {
            update: (...args: unknown[]) => mockUserUpdate(...args),
            // Outcomes are written conditionally; both land in one mock
            updateMany: (...args: unknown[]) => mockUserUpdate(...args),
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
            findMany: (...args: unknown[]) => mockUserFindMany(...args),
        },
        wallet: { findFirst: (...args: unknown[]) => mockWalletFindFirst(...args) },
        auditLog: { create: (...args: unknown[]) => mockAuditCreate(...args) },
    },
}));

const mockNotify = vi.fn();
vi.mock('../services/notification.service.js', () => ({
    notificationService: { notify: (...args: unknown[]) => mockNotify(...args) },
}));

vi.mock('../config/env.js', () => ({
    corsAllowedOrigins: ['http://localhost'],
    env: { AI_SERVICE_URL: 'http://localhost:8000', AI_API_KEY: 'test-api-key' },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const USER_ID = 'user-123';
const DOCS = [
    { id: 'doc-1', type: 'GOVERNMENT_ID', storagePath: '/uploads/gov.jpg', fileName: 'gov.jpg' },
];
const PROFILE = {
    legalName: 'Juan Dela Cruz',
    dateOfBirth: '1990-01-02',
    country: 'Philippines',
    region: null,
    province: 'Cebu',
    cityTown: 'Cebu City',
    barangay: 'Lahug',
};

function documentResponse(overrides: Record<string, unknown> = {}) {
    return {
        ok: true,
        json: vi.fn().mockResolvedValue({
            valid: true,
            document_type: 'government_id',
            confidence: 0.92,
            extracted_data: { full_name: 'Juan Dela Cruz', date_of_birth: '1990-01-02' },
            fraud_indicators: [],
            message: null,
            ...overrides,
        }),
    };
}

function scoreResponse() {
    return { ok: true, json: vi.fn().mockResolvedValue({ score: 78, tier: 'premium' }) };
}

describe('triggerAIVerification', () => {
    let triggerAIVerification: typeof import('../services/kyc-verification.service.js')['triggerAIVerification'];

    beforeEach(async () => {
        vi.clearAllMocks();
        mockFetch.mockReset();
        mockFsReadFile.mockResolvedValue(Buffer.from('fake-image'));
        mockDocUpdate.mockResolvedValue({});
        mockUserUpdate.mockResolvedValue({ count: 1 });
        mockAuditCreate.mockResolvedValue({});
        mockNotify.mockResolvedValue(undefined);
        mockWalletFindFirst.mockResolvedValue({ address: '0xabc' });
        mockUserFindUnique.mockImplementation(async (args: { select?: Record<string, boolean> }) =>
            args.select?.legalName
                ? PROFILE
                : { totalBorrowed: 0, totalRepaid: 0, completedLoansCount: 0, activeLoansCount: 0, defaultCount: 0 },
        );
        ({ triggerAIVerification } = await import('../services/kyc-verification.service.js'));
    });

    it('verifies a document, cross-checks identity, and approves a matching participant', async () => {
        mockFetch.mockResolvedValueOnce(documentResponse()).mockResolvedValueOnce(scoreResponse());

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/verify/document?document_type=government_id');
        expect(mockDocUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'doc-1' },
            data: expect.objectContaining({ aiVerified: true, aiConfidence: 0.92 }),
        }));
        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
            // 78 is below the Premium plan floor of 80, whatever tier the scorer names
            data: expect.objectContaining({ status: 'APPROVED', creditScore: 78, creditTier: 'STANDARD' }),
        }));
        expect(mockNotify).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ type: 'KYC_APPROVED' }));
    });

    it('does not send an e-signature to document AI', async () => {
        await triggerAIVerification(USER_ID, [
            { id: 'sig-1', type: 'E_SIGNATURE', storagePath: '/uploads/sig.png', fileName: 'sig.png' },
        ]);

        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'VERIFIED' }),
        }));
    });

    it('rejects an identity mismatch and says which field failed', async () => {
        mockFetch.mockResolvedValueOnce(documentResponse({
            extracted_data: { full_name: 'Different Person', date_of_birth: '1985-05-05' },
        }));

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'REJECTED',
                kycRejectionReason: expect.stringContaining('name printed on your ID'),
            }),
        }));
        expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ action: 'KYC_REJECTED' }),
        }));
    });

    it('tells the borrower how to retake the photo when identity does not match', async () => {
        mockFetch.mockResolvedValueOnce(documentResponse({
            extracted_data: { full_name: 'Different Person', date_of_birth: '1985-05-05' },
        }));

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                kycRejectionReason: expect.stringContaining('glare'),
            }),
        }));
    });

    it('rejects an AI-flagged document and tells the borrower why', async () => {
        mockFetch.mockResolvedValueOnce(documentResponse({
            valid: false,
            confidence: 0.2,
            fraud_indicators: ['suspected manipulation'],
            extracted_data: {},
            message: 'Document needs review',
        }));

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockDocUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ aiVerified: false, status: 'REJECTED' }),
        }));
        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'REJECTED',
                kycRejectionReason: expect.stringContaining('Document needs review'),
            }),
        }));
        expect(mockNotify).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ type: 'KYC_REJECTED' }));
    });

    it('does not blame the borrower when the AI service is unavailable', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        await expect(triggerAIVerification(USER_ID, DOCS)).resolves.toBeUndefined();

        // VERIFIED, not REJECTED — an outage is not evidence, and it is the only
        // state /kyc/submit will accept again.
        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'VERIFIED',
                kycRejectionReason: expect.stringContaining('not rejected'),
            }),
        }));
        expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ action: 'KYC_VERIFICATION_UNAVAILABLE' }),
        }));
    });
});

describe('verifyFace', () => {
    let verifyFace: typeof import('../services/kyc-verification.service.js')['verifyFace'];
    const selfie = Buffer.from('fake-selfie');
    const governmentId = {
        id: 'gov-1',
        storagePath: '/uploads/gov.jpg',
        fileName: 'gov.jpg',
        status: 'PENDING',
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        mockFetch.mockReset();
        mockFsReadFile.mockResolvedValue(Buffer.from('fake-id'));
        mockFsUnlink.mockResolvedValue(undefined);
        mockDocFindFirst.mockReset();
        mockDocCreate.mockResolvedValue({ id: 'selfie-1' });
        mockDocUpdate.mockResolvedValue({ id: 'selfie-1' });
        mockAuditCreate.mockResolvedValue({});
        ({ verifyFace } = await import('../services/kyc-verification.service.js'));
    });

    it('requires an uploaded government ID', async () => {
        mockDocFindFirst.mockResolvedValueOnce(null);
        await expect(verifyFace(USER_ID, selfie, 'selfie.jpg', '/uploads/selfie.jpg'))
            .rejects.toThrow('GOVERNMENT_ID_REQUIRED');
    });

    it('stores and returns a successful face match', async () => {
        mockDocFindFirst.mockResolvedValueOnce(governmentId).mockResolvedValueOnce(null);
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: vi.fn().mockResolvedValue({ passed: true, score: 0.93, confidence: 0.95, message: null }),
        });

        const result = await verifyFace(USER_ID, selfie, 'selfie.jpg', '/uploads/selfie.jpg');

        expect(result).toMatchObject({ passed: true, score: 0.93, selfieDocumentId: 'selfie-1' });
        expect(mockDocCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ faceMatchPassed: true, faceMatchScore: 0.93 }),
        }));
    });

    it('does not record a failed match when the face service is down', async () => {
        mockDocFindFirst.mockResolvedValueOnce(governmentId).mockResolvedValueOnce(null);
        mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: vi.fn().mockResolvedValue({}) });

        const { FaceServiceUnavailableError } = await import('../services/kyc-verification.service.js');
        await expect(verifyFace(USER_ID, selfie, 'selfie.jpg', '/uploads/selfie.jpg'))
            .rejects.toBeInstanceOf(FaceServiceUnavailableError);
        expect(mockDocCreate).not.toHaveBeenCalled();
        expect(mockDocUpdate).not.toHaveBeenCalled();
    });

    it('passes the face service reason through when the photo is the problem', async () => {
        mockDocFindFirst.mockResolvedValueOnce(governmentId).mockResolvedValueOnce(null);
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 422,
            json: vi.fn().mockResolvedValue({ detail: 'No face detected in the selfie. Please take a clear, well-lit photo facing the camera.' }),
        });

        const result = await verifyFace(USER_ID, selfie, 'selfie.jpg', '/uploads/selfie.jpg');

        expect(result).toMatchObject({ passed: false, message: expect.stringContaining('No face detected') });
        expect(result.message).not.toMatch(/HTTP/);
    });
});

describe('identity matching helpers', () => {
    let comparableDate: (v: unknown) => string;
    let tokenSimilarity: (a: unknown, b: unknown) => number;

    beforeEach(async () => {
        ({ comparableDate, tokenSimilarity } = await import('../services/kyc-verification.service.js'));
    });

    // The profile date arrives as a Prisma DateTime (UTC midnight); the OCR value is
    // a bare string that parses as local midnight. Reading the latter back through
    // toISOString shifted it a day earlier anywhere east of UTC, so no birth date
    // matched and every KYC submission fell through to manual review.
    it('matches a spelled-out birth date against the stored profile date', () => {
        expect(comparableDate('DECEMBER 23, 1975')).toBe('1975-12-23');
        expect(comparableDate(new Date('1975-12-23T00:00:00.000Z'))).toBe('1975-12-23');
        expect(comparableDate('DECEMBER 23, 1975')).toBe(
            comparableDate(new Date('1975-12-23T00:00:00.000Z')),
        );
    });

    it('matches a new year birth date, the worst case for the offset', () => {
        expect(comparableDate('January 01, 1990')).toBe(
            comparableDate(new Date('1990-01-01T00:00:00.000Z')),
        );
    });

    it('passes an ISO date through untouched', () => {
        expect(comparableDate('1990-01-01')).toBe('1990-01-01');
    });

    it('falls back to normalised text when the value is not a date', () => {
        expect(comparableDate('not a date')).toBe('not a date');
        expect(comparableDate(null)).toBe('');
    });

    it('scores a full name match above the 0.7 approval threshold', () => {
        expect(tokenSimilarity('Marianne Solis Sanchez', 'MARIANNE SOLIS SANCHEZ')).toBe(1);
        expect(tokenSimilarity('Marianne Sanchez', 'MARIANNE SOLIS SANCHEZ')).toBeGreaterThanOrEqual(0.7);
    });

    it('scores an unrelated name below the threshold', () => {
        expect(tokenSimilarity('Juan Dela Cruz', 'MARIANNE SOLIS SANCHEZ')).toBeLessThan(0.7);
        // An initial instead of the middle name does not clear it either.
        expect(tokenSimilarity('Marianne S. Sanchez', 'MARIANNE SOLIS SANCHEZ')).toBeLessThan(0.7);
    });
});

describe('AI service failures and late results', () => {
    let kyc: typeof import('../services/kyc-verification.service.js');

    beforeEach(async () => {
        vi.clearAllMocks();
        mockFetch.mockReset();
        mockFsReadFile.mockResolvedValue(Buffer.from('fake-image'));
        mockDocUpdate.mockResolvedValue({});
        mockUserUpdate.mockResolvedValue({ count: 1 });
        mockAuditCreate.mockResolvedValue({});
        mockNotify.mockResolvedValue(undefined);
        mockWalletFindFirst.mockResolvedValue(null);
        mockUserFindUnique.mockImplementation(async (args: { select?: Record<string, boolean> }) =>
            args.select?.legalName
                ? PROFILE
                : { totalBorrowed: 0, totalRepaid: 0, completedLoansCount: 0, activeLoansCount: 0, defaultCount: 0 },
        );
        kyc = await import('../services/kyc-verification.service.js');
    });

    it.each([500, 401, 503])('keeps the borrower unrejected when the AI answers HTTP %i', async (status) => {
        mockFetch.mockResolvedValueOnce({ ok: false, status, json: vi.fn() });

        await kyc.triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'VERIFIED', kycRejectionReason: expect.stringContaining('not rejected') }),
        }));
        const statuses = mockUserUpdate.mock.calls.map((c) => c[0].data.status);
        expect(statuses).not.toContain('REJECTED');
        const docStatuses = mockDocUpdate.mock.calls.map((c) => c[0].data.status);
        expect(docStatuses).not.toContain('REJECTED');
    });

    it('asks for a retake when the AI cannot read the image', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 422, json: vi.fn().mockResolvedValue({}) });

        await kyc.triggerAIVerification(USER_ID, DOCS);

        const rejection = mockUserUpdate.mock.calls.find((c) => c[0].data.status === 'REJECTED');
        expect(rejection).toBeDefined();
        expect(rejection![0].data.kycRejectionReason).toMatch(/could not be read/i);
        expect(rejection![0].data.kycRejectionReason).not.toMatch(/HTTP/);
    });

    it('gives up on an AI call that hangs', async () => {
        mockFetch.mockResolvedValueOnce(documentResponse()).mockResolvedValueOnce(scoreResponse());
        await kyc.triggerAIVerification(USER_ID, DOCS);
        for (const [, options] of mockFetch.mock.calls) {
            expect(options.signal).toBeInstanceOf(AbortSignal);
        }
    });

    it('writes outcomes only while the user is still awaiting review', async () => {
        mockFetch.mockResolvedValueOnce(documentResponse()).mockResolvedValueOnce(scoreResponse());
        mockUserUpdate.mockResolvedValue({ count: 0 });

        await kyc.triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: USER_ID, status: 'PENDING_KYC' },
        }));
        expect(mockNotify).not.toHaveBeenCalledWith(USER_ID, expect.objectContaining({ type: 'KYC_APPROVED' }));
        expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ action: 'KYC_AI_RESULT_IGNORED' }),
        }));
    });

    it.each([150, -1, null, 'abc', 72.5])('does not store the unusable score %s', async (score) => {
        mockFetch
            .mockResolvedValueOnce(documentResponse({ confidence: 0.99 }))
            .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ score, tier: 'vip' }) });

        await kyc.triggerAIVerification(USER_ID, DOCS);

        const approval = mockUserUpdate.mock.calls.find((c) => c[0].data.status === 'APPROVED');
        expect(approval).toBeDefined();
        // Fallback: confidence-based, capped at entry level
        expect(approval![0].data.creditScore).toBe(59);
        expect(approval![0].data.creditTier).toBe('BASIC');
        expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ metadata: expect.objectContaining({ scoreSource: 'fallback' }) }),
        }));
    });

    it.each([[95, 'VIP'], [90, 'VIP'], [89, 'PREMIUM'], [80, 'PREMIUM'], [60, 'STANDARD'], [59, 'BASIC'], [30, 'BASIC']])(
        'labels a score of %i as %s, matching the plan floors',
        (score, tier) => {
            expect(kyc.deriveTier(score as number)).toBe(tier);
        },
    );

    it('returns users stranded mid-verification to a state they can resubmit from', async () => {
        await kyc.recoverStalledKyc();

        const [args] = mockUserUpdate.mock.calls[0];
        expect(args.where.status).toBe('PENDING_KYC');
        expect(args.where.kycSubmittedAt.lt).toBeInstanceOf(Date);
        expect(args.data.status).toBe('VERIFIED');
        expect(args.data.kycRejectionReason).toMatch(/not rejected/);
    });
});
