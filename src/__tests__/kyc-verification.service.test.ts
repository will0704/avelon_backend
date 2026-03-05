import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────
const mockFsReadFile = vi.fn();
vi.mock('fs/promises', () => ({ default: { readFile: (...a: unknown[]) => mockFsReadFile(...a) } }));

const mockDocUpdate = vi.fn();
const mockUserUpdate = vi.fn();
const mockAuditCreate = vi.fn();
vi.mock('../lib/prisma.js', () => ({
    prisma: {
        document: { update: (...a: unknown[]) => mockDocUpdate(...a) },
        user: { update: (...a: unknown[]) => mockUserUpdate(...a) },
        auditLog: { create: (...a: unknown[]) => mockAuditCreate(...a) },
    },
}));

const mockNotify = vi.fn();
vi.mock('../services/notification.service.js', () => ({
    notificationService: { notify: (...a: unknown[]) => mockNotify(...a) },
}));

vi.mock('../config/env.js', () => ({
    env: { AI_SERVICE_URL: 'http://localhost:8000' },
}));

// Global fetch mock
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function aiSuccessResponse(overrides: Record<string, unknown> = {}) {
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

function aiFailedResponse(overrides: Record<string, unknown> = {}) {
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

const USER_ID = 'user-123';
const DOCS = [
    { id: 'doc-1', type: 'GOVERNMENT_ID', storagePath: '/uploads/gov.jpg', fileName: 'gov.jpg' },
];
const TWO_DOCS = [
    { id: 'doc-1', type: 'GOVERNMENT_ID', storagePath: '/uploads/gov.jpg', fileName: 'gov.jpg' },
    { id: 'doc-2', type: 'PROOF_OF_INCOME', storagePath: '/uploads/income.jpg', fileName: 'income.jpg' },
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

        const mod = await import('../services/kyc-verification.service.js');
        triggerAIVerification = mod.triggerAIVerification;
    });

    // ────── Document verification ──────

    it('sends each document to the AI service with correct form data', async () => {
        mockFetch.mockResolvedValue(aiSuccessResponse());

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toBe('http://localhost:8000/api/v1/verify/document');
        expect(opts.method).toBe('POST');
        expect(opts.body).toBeInstanceOf(FormData);
    });

    it('stores AI results on the document record', async () => {
        mockFetch.mockResolvedValue(aiSuccessResponse({ confidence: 0.88 }));

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
        mockFetch.mockResolvedValue(aiSuccessResponse({ confidence: 0.92 }));

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

    it('assigns credit score from average AI confidence (scaled 0-100)', async () => {
        mockFetch
            .mockResolvedValueOnce(aiSuccessResponse({ confidence: 0.90 }))
            .mockResolvedValueOnce(aiSuccessResponse({ confidence: 0.80 }));

        await triggerAIVerification(USER_ID, TWO_DOCS);

        // Average confidence = 0.85, scaled to 85
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    creditScore: 85,
                }),
            }),
        );
    });

    it('assigns correct KYC level based on document types', async () => {
        mockFetch
            .mockResolvedValueOnce(aiSuccessResponse())
            .mockResolvedValueOnce(aiSuccessResponse());

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
        mockFetch.mockResolvedValue(aiSuccessResponse());

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
        mockFetch.mockResolvedValue(aiSuccessResponse());

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
        mockFetch.mockResolvedValue(aiFailedResponse());

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
        mockFetch.mockResolvedValue(aiFailedResponse());

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockNotify).toHaveBeenCalledWith(
            USER_ID,
            expect.objectContaining({
                type: 'KYC_REJECTED',
            }),
        );
    });

    it('rejects documents with status REJECTED', async () => {
        mockFetch.mockResolvedValue(aiFailedResponse());

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

    it('does not throw when AI returns non-ok status', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 500 });

        await expect(triggerAIVerification(USER_ID, DOCS)).resolves.not.toThrow();
    });

    // ────── Tier mapping ──────

    it('assigns BASIC tier for score < 40', async () => {
        mockFetch.mockResolvedValue(aiSuccessResponse({ confidence: 0.35 }));

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ creditTier: 'BASIC' }),
            }),
        );
    });

    it('assigns STANDARD tier for score 40-59', async () => {
        mockFetch.mockResolvedValue(aiSuccessResponse({ confidence: 0.50 }));

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ creditTier: 'STANDARD' }),
            }),
        );
    });

    it('assigns PREMIUM tier for score 60-79', async () => {
        mockFetch.mockResolvedValue(aiSuccessResponse({ confidence: 0.70 }));

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ creditTier: 'PREMIUM' }),
            }),
        );
    });

    it('assigns VIP tier for score >= 80', async () => {
        mockFetch.mockResolvedValue(aiSuccessResponse({ confidence: 0.92 }));

        await triggerAIVerification(USER_ID, DOCS);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ creditTier: 'VIP' }),
            }),
        );
    });
});
