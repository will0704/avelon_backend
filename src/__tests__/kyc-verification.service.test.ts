import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────
const mockFsReadFile = vi.fn();
const mockFsWriteFile = vi.fn();
const mockFsUnlink = vi.fn();
vi.mock('fs/promises', () => ({
    default: {
        readFile: (...a: unknown[]) => mockFsReadFile(...a),
        writeFile: (...a: unknown[]) => mockFsWriteFile(...a),
        unlink: (...a: unknown[]) => mockFsUnlink(...a),
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
            update: (...a: unknown[]) => mockDocUpdate(...a),
            create: (...a: unknown[]) => mockDocCreate(...a),
            findFirst: (...a: unknown[]) => mockDocFindFirst(...a),
        },
        user: {
            update: (...a: unknown[]) => mockUserUpdate(...a),
            findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
        },
        wallet: {
            findFirst: (...a: unknown[]) => mockWalletFindFirst(...a),
        },
        auditLog: { create: (...a: unknown[]) => mockAuditCreate(...a) },
    },
}));

const mockNotify = vi.fn();
vi.mock('../services/notification.service.js', () => ({
    notificationService: { notify: (...a: unknown[]) => mockNotify(...a) },
}));

vi.mock('../config/env.js', () => ({
    env: { AI_SERVICE_URL: 'http://localhost:8000', AI_API_KEY: 'test-api-key' },
}));

// Global fetch mock
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function aiDocResponse(overrides: Record<string, unknown> = {}) {
    return {
        ok: true,
        json: () => Promise.resolve({
            valid: true,
            document_type: 'government_id',
            confidence: 0.92,
            extracted_data: { full_name: 'Juan Dela Cruz' },
            fraud_indicators: [],
            message: null,
            ...overrides,
        }),
    };
}

function aiDocFailedResponse(overrides: Record<string, unknown> = {}) {
    return {
        ok: true,
        json: () => Promise.resolve({
            valid: false,
            document_type: 'government_id',
            confidence: 0.3,
            extracted_data: {},
            fraud_indicators: ['Suspected image manipulation'],
            message: 'Document rejected due to high fraud probability.',
            ...overrides,
        }),
    };
}

function scoreResponse(overrides: Record<string, unknown> = {}) {
    return {
        ok: true,
        json: () => Promise.resolve({
            score: 85,
            tier: 'vip',
            breakdown: {},
            recommendations: [],
            ...overrides,
        }),
    };
}

function faceMatchResponse(overrides: Record<string, unknown> = {}) {
    return {
        ok: true,
        json: () => Promise.resolve({
            passed: true,
            score: 0.92,
            confidence: 0.95,
            message: null,
            ...overrides,
        }),
    };
}

const USER_ID = 'user-123';
const DOCS = [
    { id: 'doc-1', type: 'GOVERNMENT_ID', storagePath: '/uploads/gov.jpg', fileName: 'gov.jpg' },
];
const TWO_DOCS = [
    { id: 'doc-1', type: 'GOVERNMENT_ID', storagePath: '/uploads/gov.jpg', fileName: 'gov.jpg' },
    { id: 'doc-2', type: 'PROOF_OF_INCOME', storagePath: '/uploads/income.jpg', fileName: 'income.jpg' },
];
const FULL_DOCS = [
    { id: 'doc-1', type: 'GOVERNMENT_ID', storagePath: '/uploads/gov.jpg', fileName: 'gov.jpg' },
    { id: 'doc-2', type: 'GOVERNMENT_ID_BACK', storagePath: '/uploads/gov_back.jpg', fileName: 'gov_back.jpg' },
    { id: 'doc-3', type: 'E_SIGNATURE', storagePath: '/uploads/sig.jpg', fileName: 'sig.jpg' },
];

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('triggerAIVerification', () => {
    let triggerAIVerification: typeof import('../services/kyc-verification.service.js')['triggerAIVerification'];

    beforeEach(async () => {
        vi.clearAllMocks();
        mockFsReadFile.mockResolvedValue(Buffer.from('fake-image'));
        mockDocUpdate.mockResolvedValue({});
        mockUserUpdate.mockResolvedValue({});
        mockAuditCreate.mockResolvedValue({});
        mockNotify.mockResolvedValue(undefined);
        // Credit score dependencies
        mockWalletFindFirst.mockResolvedValue({ address: '0xabc' });
        mockUserFindUnique.mockResolvedValue({ completedLoansCount: 0, activeLoansCount: 0, defaultCount: 0 });

        const mod = await import('../services/kyc-verification.service.js');
        triggerAIVerification = mod.triggerAIVerification;
    });

    // ────── Document verification ──────

    it('sends each document to the AI service with correct form data', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse())
            .mockResolvedValueOnce(scoreResponse());

        await triggerAIVerification(USER_ID, DOCS);

        const docCall = mockFetch.mock.calls[0];
        expect(docCall[0]).toContain('http://localhost:8000/api/v1/verify/document');
        expect(docCall[1].method).toBe('POST');
        expect(docCall[1].body).toBeInstanceOf(FormData);
    });

    it('sends document_type as a URL query parameter, not form data', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse())
            .mockResolvedValueOnce(scoreResponse());

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockFetch.mock.calls[0][0]).toContain('?document_type=government_id');
    });

    it('maps GOVERNMENT_ID_BACK to government_id for the AI service', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse())
            .mockResolvedValueOnce(scoreResponse());
        const docs = [{ id: 'doc-1', type: 'GOVERNMENT_ID_BACK', storagePath: '/uploads/back.jpg', fileName: 'back.jpg' }];

        await triggerAIVerification(USER_ID, docs);

        expect(mockFetch.mock.calls[0][0]).toContain('?document_type=government_id');
    });

    it('skips E_SIGNATURE documents — does not send to AI service', async () => {
        // FULL_DOCS has 3 docs but E_SIGNATURE skipped → 2 doc calls + 1 score call
        mockFetch
            .mockResolvedValueOnce(aiDocResponse())
            .mockResolvedValueOnce(aiDocResponse())
            .mockResolvedValueOnce(scoreResponse());

        await triggerAIVerification(USER_ID, FULL_DOCS);

        const docCalls = mockFetch.mock.calls.filter((c: unknown[]) =>
            (c[0] as string).includes('/verify/document'),
        );
        expect(docCalls).toHaveLength(2);
        expect(docCalls.every((c: unknown[]) => (c[0] as string).includes('government_id'))).toBe(true);
    });

    it('auto-approves even when E_SIGNATURE is in the documents list', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse())
            .mockResolvedValueOnce(aiDocResponse())
            .mockResolvedValueOnce(scoreResponse());

        await triggerAIVerification(USER_ID, FULL_DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: 'APPROVED' }),
            }),
        );
    });

    it('stores AI results on the document record', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse({ confidence: 0.88 }))
            .mockResolvedValueOnce(scoreResponse());

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockDocUpdate).toHaveBeenCalledWith({
            where: { id: 'doc-1' },
            data: expect.objectContaining({
                aiVerified: true,
                aiConfidence: 0.88,
                aiFraudFlags: [],
            }),
        });
    });

    // ────── Auto-approve ──────

    it('auto-approves user when all documents pass', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse({ confidence: 0.92 }))
            .mockResolvedValueOnce(scoreResponse());

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: USER_ID },
                data: expect.objectContaining({
                    status: 'APPROVED',
                    kycLevel: 'BASIC',
                    kycApprovedAt: expect.any(Date),
                    kycRejectionReason: null,
                }),
            }),
        );
    });

    it('uses credit score from the LLM score endpoint', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse({ confidence: 0.90 }))
            .mockResolvedValueOnce(aiDocResponse({ confidence: 0.80 }))
            .mockResolvedValueOnce(scoreResponse({ score: 78, tier: 'premium' }));

        await triggerAIVerification(USER_ID, TWO_DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    creditScore: 78,
                    creditTier: 'PREMIUM',
                }),
            }),
        );
    });

    it('calls the score endpoint with merged extracted data and wallet address', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse({ extracted_data: { full_name: 'Juan' } }))
            .mockResolvedValueOnce(scoreResponse());
        mockWalletFindFirst.mockResolvedValue({ address: '0xdeadbeef' });

        await triggerAIVerification(USER_ID, DOCS);

        const scoreCall = mockFetch.mock.calls.find((c: unknown[]) =>
            (c[0] as string).includes('/score/calculate'),
        );
        expect(scoreCall).toBeDefined();
        const body = JSON.parse(scoreCall![1].body);
        expect(body.wallet_address).toBe('0xdeadbeef');
        expect(body.extracted_data).toMatchObject({ full_name: 'Juan' });
    });

    it('falls back to confidence-based score when score endpoint fails', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse({ confidence: 0.70 }))
            .mockResolvedValueOnce({ ok: false, status: 503 });

        await triggerAIVerification(USER_ID, DOCS);

        // Fallback: round(0.70 * 100) = 70 → PREMIUM
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    creditScore: 70,
                    creditTier: 'PREMIUM',
                }),
            }),
        );
    });

    it('assigns correct KYC level based on document types', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse())
            .mockResolvedValueOnce(aiDocResponse())
            .mockResolvedValueOnce(scoreResponse());

        await triggerAIVerification(USER_ID, TWO_DOCS);

        // 2 docs (gov ID + proof of income) → STANDARD
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    kycLevel: 'STANDARD',
                }),
            }),
        );
    });

    it('sends KYC_APPROVED notification when approved', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse())
            .mockResolvedValueOnce(scoreResponse());

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockNotify).toHaveBeenCalledWith(
            USER_ID,
            expect.objectContaining({
                type: 'KYC_APPROVED',
                title: expect.stringContaining('Verified'),
            }),
        );
    });

    it('creates an audit log entry on approval', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse())
            .mockResolvedValueOnce(scoreResponse());

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockAuditCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: USER_ID,
                action: 'KYC_APPROVED',
                entity: 'User',
                entityId: USER_ID,
            }),
        });
    });

    // ────── Auto-reject ──────

    it('auto-rejects user when any document fails', async () => {
        mockFetch.mockResolvedValue(aiDocFailedResponse());

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: USER_ID },
                data: expect.objectContaining({
                    status: 'REJECTED',
                    kycRejectionReason: expect.any(String),
                }),
            }),
        );
    });

    it('sends KYC_REJECTED notification on rejection', async () => {
        mockFetch.mockResolvedValue(aiDocFailedResponse());

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockNotify).toHaveBeenCalledWith(
            USER_ID,
            expect.objectContaining({ type: 'KYC_REJECTED' }),
        );
    });

    it('rejects documents with status REJECTED', async () => {
        mockFetch.mockResolvedValue(aiDocFailedResponse());

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockDocUpdate).toHaveBeenCalledWith({
            where: { id: 'doc-1' },
            data: expect.objectContaining({
                aiVerified: false,
                status: 'REJECTED',
            }),
        });
    });

    // ────── Error handling ──────

    it('does not throw when AI service is unreachable (fire-and-forget)', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(triggerAIVerification(USER_ID, DOCS)).resolves.not.toThrow();
    });

    it('auto-rejects user when AI service throws (e.g. ECONNREFUSED)', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: USER_ID },
                data: expect.objectContaining({
                    status: 'REJECTED',
                    kycRejectionReason: expect.stringContaining('system error'),
                }),
            }),
        );
    });

    it('does not throw when AI returns non-ok status', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 500 });

        await expect(triggerAIVerification(USER_ID, DOCS)).resolves.not.toThrow();
    });

    it('marks document as REJECTED when AI returns non-ok status (e.g. 422)', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 422 });

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockDocUpdate).toHaveBeenCalledWith({
            where: { id: 'doc-1' },
            data: expect.objectContaining({
                status: 'REJECTED',
                rejectionReason: expect.stringContaining('AI service'),
            }),
        });
    });

    it('auto-rejects user when all documents fail with non-ok HTTP status', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 422 });

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: USER_ID },
                data: expect.objectContaining({ status: 'REJECTED' }),
            }),
        );
    });

    it('sends KYC_REJECTED notification when all documents fail with HTTP errors', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 422 });

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockNotify).toHaveBeenCalledWith(
            USER_ID,
            expect.objectContaining({
                type: 'KYC_REJECTED',
                title: expect.stringContaining('Failed'),
            }),
        );
    });

    it('creates audit log when all documents fail with HTTP errors', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 422 });

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockAuditCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: USER_ID,
                action: 'KYC_REJECTED',
                entity: 'User',
                entityId: USER_ID,
            }),
        });
    });

    // ────── Tier mapping (uses fallback score for determinism) ──────

    it('assigns BASIC tier for fallback score < 40', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse({ confidence: 0.35 }))
            .mockResolvedValueOnce({ ok: false, status: 503 }); // force fallback

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ creditTier: 'BASIC' }),
            }),
        );
    });

    it('assigns STANDARD tier for fallback score 40-59', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse({ confidence: 0.50 }))
            .mockResolvedValueOnce({ ok: false, status: 503 });

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ creditTier: 'STANDARD' }),
            }),
        );
    });

    it('assigns PREMIUM tier for fallback score 60-79', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse({ confidence: 0.70 }))
            .mockResolvedValueOnce({ ok: false, status: 503 });

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ creditTier: 'PREMIUM' }),
            }),
        );
    });

    it('assigns VIP tier for fallback score >= 80', async () => {
        mockFetch
            .mockResolvedValueOnce(aiDocResponse({ confidence: 0.92 }))
            .mockResolvedValueOnce({ ok: false, status: 503 });

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ creditTier: 'VIP' }),
            }),
        );
    });
});

// ─── verifyFace tests ────────────────────────────────────────────────────────
describe('verifyFace', () => {
    let verifyFace: typeof import('../services/kyc-verification.service.js')['verifyFace'];

    const SELFIE_BUFFER = Buffer.from('fake-selfie');
    const GOV_ID_DOC = {
        id: 'gov-doc-1',
        storagePath: '/uploads/user-123/GOVERNMENT_ID_123.jpg',
        fileName: 'GOVERNMENT_ID_123.jpg',
        status: 'PENDING',
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        mockFsReadFile.mockResolvedValue(Buffer.from('fake-gov-id'));
        mockFsWriteFile.mockResolvedValue(undefined);
        mockFsUnlink.mockResolvedValue(undefined);
        mockDocUpdate.mockResolvedValue({ id: 'selfie-doc-1' });
        mockDocCreate.mockResolvedValue({ id: 'selfie-doc-1' });
        mockAuditCreate.mockResolvedValue({});

        const mod = await import('../services/kyc-verification.service.js');
        verifyFace = mod.verifyFace;
    });

    it('throws GOVERNMENT_ID_REQUIRED when no gov ID document exists', async () => {
        mockDocFindFirst.mockResolvedValueOnce(null); // no gov ID

        await expect(
            verifyFace(USER_ID, SELFIE_BUFFER, 'selfie.jpg', '/uploads/selfie.jpg'),
        ).rejects.toThrow('GOVERNMENT_ID_REQUIRED');
    });

    it('calls LLM /verify/face with selfie and government ID files', async () => {
        mockDocFindFirst
            .mockResolvedValueOnce(GOV_ID_DOC)  // findFirst for gov ID
            .mockResolvedValueOnce(null);         // findFirst for existing selfie
        mockFetch.mockResolvedValue(faceMatchResponse());

        await verifyFace(USER_ID, SELFIE_BUFFER, 'selfie.jpg', '/uploads/selfie.jpg');

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toContain('http://localhost:8000/api/v1/verify/face');
        expect(opts.method).toBe('POST');
        expect(opts.body).toBeInstanceOf(FormData);
    });

    it('returns passed=true and score when face matches', async () => {
        mockDocFindFirst
            .mockResolvedValueOnce(GOV_ID_DOC)
            .mockResolvedValueOnce(null);
        mockFetch.mockResolvedValue(faceMatchResponse({ passed: true, score: 0.95 }));

        const result = await verifyFace(USER_ID, SELFIE_BUFFER, 'selfie.jpg', '/uploads/selfie.jpg');

        expect(result.passed).toBe(true);
        expect(result.score).toBe(0.95);
    });

    it('returns passed=false when face does not match', async () => {
        mockDocFindFirst
            .mockResolvedValueOnce(GOV_ID_DOC)
            .mockResolvedValueOnce(null);
        mockFetch.mockResolvedValue(faceMatchResponse({ passed: false, score: 0.21, message: 'Face does not match ID' }));

        const result = await verifyFace(USER_ID, SELFIE_BUFFER, 'selfie.jpg', '/uploads/selfie.jpg');

        expect(result.passed).toBe(false);
        expect(result.score).toBe(0.21);
        expect(result.message).toBe('Face does not match ID');
    });

    it('creates a SELFIE document record when none exists', async () => {
        mockDocFindFirst
            .mockResolvedValueOnce(GOV_ID_DOC)
            .mockResolvedValueOnce(null); // no existing selfie
        mockFetch.mockResolvedValue(faceMatchResponse({ passed: true, score: 0.9 }));

        await verifyFace(USER_ID, SELFIE_BUFFER, 'selfie.jpg', '/uploads/selfie.jpg');

        expect(mockDocCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    userId: USER_ID,
                    type: 'SELFIE',
                    faceMatchPassed: true,
                    faceMatchScore: 0.9,
                }),
            }),
        );
    });

    it('updates the existing SELFIE document when one already exists (non-APPROVED)', async () => {
        const existingSelfie = { id: 'old-selfie', status: 'PENDING', storagePath: '/uploads/old.jpg' };
        mockDocFindFirst
            .mockResolvedValueOnce(GOV_ID_DOC)
            .mockResolvedValueOnce(existingSelfie);
        mockFetch.mockResolvedValue(faceMatchResponse({ passed: true, score: 0.88 }));

        await verifyFace(USER_ID, SELFIE_BUFFER, 'selfie.jpg', '/uploads/selfie.jpg');

        expect(mockDocUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'old-selfie' },
                data: expect.objectContaining({
                    faceMatchPassed: true,
                    faceMatchScore: 0.88,
                }),
            }),
        );
    });

    it('stores passed=false on document when LLM service is unreachable', async () => {
        mockDocFindFirst
            .mockResolvedValueOnce(GOV_ID_DOC)
            .mockResolvedValueOnce(null);
        mockFetch.mockResolvedValue({ ok: false, status: 503 });

        const result = await verifyFace(USER_ID, SELFIE_BUFFER, 'selfie.jpg', '/uploads/selfie.jpg');

        expect(result.passed).toBe(false);
        expect(result.score).toBe(0);
        expect(mockDocCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ faceMatchPassed: false }),
            }),
        );
    });

    it('creates an audit log entry after face verification', async () => {
        mockDocFindFirst
            .mockResolvedValueOnce(GOV_ID_DOC)
            .mockResolvedValueOnce(null);
        mockFetch.mockResolvedValue(faceMatchResponse({ passed: true, score: 0.9 }));

        await verifyFace(USER_ID, SELFIE_BUFFER, 'selfie.jpg', '/uploads/selfie.jpg');

        expect(mockAuditCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: USER_ID,
                action: 'KYC_FACE_VERIFIED',
                entity: 'Document',
            }),
        });
    });

    it('returns the selfie document ID in the result', async () => {
        mockDocFindFirst
            .mockResolvedValueOnce(GOV_ID_DOC)
            .mockResolvedValueOnce(null);
        mockDocCreate.mockResolvedValue({ id: 'new-selfie-doc' });
        mockFetch.mockResolvedValue(faceMatchResponse());

        const result = await verifyFace(USER_ID, SELFIE_BUFFER, 'selfie.jpg', '/uploads/selfie.jpg');

        expect(result.selfieDocumentId).toBe('new-selfie-doc');
    });
});
