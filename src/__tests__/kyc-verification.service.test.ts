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
const mockDocCreate = vi.fn();
const mockDocFindFirst = vi.fn();
const mockUserUpdate = vi.fn();
const mockUserFindUnique = vi.fn();
const mockWalletFindFirst = vi.fn();
const mockAuditCreate = vi.fn();
vi.mock('../lib/prisma.js', () => ({
    prisma: {
        document: {
            update: (...args: unknown[]) => mockDocUpdate(...args),
            create: (...args: unknown[]) => mockDocCreate(...args),
            findFirst: (...args: unknown[]) => mockDocFindFirst(...args),
        },
        user: {
            update: (...args: unknown[]) => mockUserUpdate(...args),
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
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
        mockUserUpdate.mockResolvedValue({});
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
            data: expect.objectContaining({ status: 'APPROVED', creditScore: 78, creditTier: 'PREMIUM' }),
        }));
        expect(mockNotify).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ type: 'KYC_APPROVED' }));
    });

    it('does not send an e-signature to document AI', async () => {
        await triggerAIVerification(USER_ID, [
            { id: 'sig-1', type: 'E_SIGNATURE', storagePath: '/uploads/sig.png', fileName: 'sig.png' },
        ]);

        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'PENDING_KYC' }),
        }));
    });

    it('keeps an identity mismatch pending for manual review', async () => {
        mockFetch.mockResolvedValueOnce(documentResponse({
            extracted_data: { full_name: 'Different Person', date_of_birth: '1985-05-05' },
        }));

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'PENDING_KYC',
                kycRejectionReason: expect.stringContaining('Manual review required'),
            }),
        }));
        expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ action: 'KYC_IDENTITY_MISMATCH' }),
        }));
    });

    it('keeps an AI-flagged document pending instead of auto-rejecting the participant', async () => {
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
            data: expect.objectContaining({ status: 'PENDING_KYC' }),
        }));
        expect(mockNotify).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ type: 'KYC_SUBMITTED' }));
    });

    it('keeps the participant pending when the AI service is unavailable', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        await expect(triggerAIVerification(USER_ID, DOCS)).resolves.toBeUndefined();

        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'PENDING_KYC' }),
        }));
        expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ action: 'KYC_MANUAL_REVIEW_REQUIRED' }),
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

    it('stores a failed result when the face service is unavailable', async () => {
        mockDocFindFirst.mockResolvedValueOnce(governmentId).mockResolvedValueOnce(null);
        mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

        const result = await verifyFace(USER_ID, selfie, 'selfie.jpg', '/uploads/selfie.jpg');

        expect(result).toMatchObject({ passed: false, score: 0 });
        expect(mockDocCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ faceMatchPassed: false }),
        }));
    });
});
