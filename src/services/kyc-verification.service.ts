import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { UserStatus } from '../types/index.js';
import { KYCLevel } from '../generated/prisma/enums.js';
import { notificationService } from '../services/notification.service.js';

/** Shape returned by the LLM /verify/face endpoint */
interface AIFaceMatchResult {
    passed: boolean;
    score: number;      // Cosine similarity 0-1
    confidence: number; // Model confidence 0-1
    message: string | null;
}

/** The face service is down; nothing about the selfie is known. */
export class FaceServiceUnavailableError extends Error {}

export interface FaceVerifyResult {
    passed: boolean;
    score: number;
    message: string | null;
    selfieDocumentId: string;
}

/** Shape returned by the LLM /verify/document endpoint */
interface AIDocumentResult {
    valid: boolean;
    document_type: string;
    confidence: number;
    extracted_data: Record<string, unknown>;
    fraud_indicators: string[];
    fraud_probability?: number;
    message: string | null;
}

interface VerificationDoc {
    id: string;
    type: string;
    storagePath: string;
    fileName: string;
}

function normalizeIdentity(value: unknown): string {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

export function tokenSimilarity(left: unknown, right: unknown): number {
    const a = new Set(normalizeIdentity(left).split(' ').filter(Boolean));
    const b = new Set(normalizeIdentity(right).split(' ').filter(Boolean));
    if (a.size === 0 || b.size === 0) return 0;
    const intersection = [...a].filter((token) => b.has(token)).length;
    return (2 * intersection) / (a.size + b.size);
}

function extractedValue(data: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

export function comparableDate(value: unknown): string {
    // Both sides of the comparison have to land on the same calendar day, and they
    // arrive differently: the profile date is a Prisma DateTime stored as UTC
    // midnight, while the OCR value is a bare string like "DECEMBER 23, 1975" that
    // parses as *local* midnight. Reading that one back with toISOString shifted it
    // to the previous day everywhere east of UTC, so no birth date ever matched.
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
    }

    const raw = String(value ?? '').trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return normalizeIdentity(raw);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

// ─── Tier mapping ─────────────────────────────────────────────────────────────

// Same floors as the seeded plans: Standard 60, Premium 80, VIP 90. Below 60
// only the entry plan is open.
export function deriveTier(score: number): string {
    if (score >= 90) return 'VIP';
    if (score >= 80) return 'PREMIUM';
    if (score >= 60) return 'STANDARD';
    return 'BASIC';
}

// A user the scorer never saw is not allowed past the entry plan
const FALLBACK_SCORE_CAP = 59;

const AI_DOCUMENT_TIMEOUT_MS = 90_000;
const AI_SCORE_TIMEOUT_MS = 30_000;
const STALLED_KYC_MS = 10 * 60 * 1000;

// The AI service answers these when the image itself is the problem. Anything
// else non-2xx (auth, overload, crash) is ours, not the borrower's.
const UNREADABLE_IMAGE_STATUSES = new Set([400, 413, 415, 422]);

class AIServiceUnavailableError extends Error {}

const OUTAGE_REASON =
    'Verification could not be completed because the verification service is unavailable. ' +
    'Your documents were not rejected — please submit again in a few minutes.';

function deriveKycLevel(docTypes: string[]): KYCLevel {
    const has = (t: string) => docTypes.includes(t);
    if (has('GOVERNMENT_ID') && has('PROOF_OF_INCOME') && has('PROOF_OF_ADDRESS')) return KYCLevel.ENHANCED;
    if (has('GOVERNMENT_ID') && has('PROOF_OF_INCOME')) return KYCLevel.STANDARD;
    return KYCLevel.BASIC;
}

function isUsableScore(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

/**
 * Write a verification outcome only if the user is still waiting on it. An admin
 * decision, or a newer submission, wins over an AI result that arrives late.
 */
async function applyOutcome(userId: string, data: Record<string, unknown>, what: string): Promise<boolean> {
    const result = await prisma.user.updateMany({
        where: { id: userId, status: UserStatus.PENDING_KYC },
        data,
    });
    if (result.count === 1) return true;

    await prisma.auditLog.create({
        data: {
            userId,
            action: 'KYC_AI_RESULT_IGNORED',
            entity: 'User',
            entityId: userId,
            metadata: { outcome: what, reason: 'User was no longer awaiting review' },
        },
    });
    return false;
}

async function recordOutage(userId: string, flaggedBy: string) {
    const applied = await applyOutcome(
        userId,
        { status: UserStatus.VERIFIED, kycRejectionReason: OUTAGE_REASON },
        'unavailable',
    );
    if (!applied) return;
    await prisma.auditLog.create({
        data: { userId, action: 'KYC_VERIFICATION_UNAVAILABLE', entity: 'User', entityId: userId, metadata: { reason: OUTAGE_REASON, flaggedBy } },
    });
    await notificationService.notify(userId, {
        type: 'KYC_SUBMITTED',
        title: 'Verification Unavailable',
        message: OUTAGE_REASON,
        metadata: { reason: OUTAGE_REASON },
    });
}

/**
 * Users left in PENDING_KYC by a restart or a hung call. /kyc/submit refuses that
 * status, so without this they could never try again.
 */
export async function recoverStalledKyc(): Promise<number> {
    const result = await prisma.user.updateMany({
        where: {
            status: UserStatus.PENDING_KYC,
            kycSubmittedAt: { lt: new Date(Date.now() - STALLED_KYC_MS) },
        },
        data: { status: UserStatus.VERIFIED, kycRejectionReason: OUTAGE_REASON },
    });
    if (result.count > 0) {
        console.warn(`[KYC] Returned ${result.count} stalled verification(s) to VERIFIED`);
    }
    return result.count;
}

// ─── Document type mapping ────────────────────────────────────────────────────
// Maps backend document types to LLM-compatible document_type values.
// E_SIGNATURE is skipped — it's a user-drawn signature, not a verifiable document.
const DOC_TYPE_TO_AI: Record<string, string | null> = {
    GOVERNMENT_ID:      'government_id',
    GOVERNMENT_ID_BACK: 'government_id_back',  // dedicated back-of-ID processing
    E_SIGNATURE:        null,              // skip — not a verifiable document
    PROOF_OF_INCOME:    'proof_of_income',
    PROOF_OF_ADDRESS:   'proof_of_address',
};

// Names the borrower recognises, for when a rejection has to name a document.
const DOC_LABELS: Record<string, string> = {
    GOVERNMENT_ID:      'the front of your government ID',
    GOVERNMENT_ID_BACK: 'the back of your government ID',
    PROOF_OF_INCOME:    'your proof of income',
    PROOF_OF_ADDRESS:   'your proof of address',
};

// Every rejection reason below is read by the borrower in the app, so each line
// says what to do next rather than what the model measured. The numeric scores
// stay in the audit log.
const PHOTO_GUIDANCE =
    'Retake the photo in bright, even light with the whole card flat in the frame, ' +
    'and keep it free of glare, shadows and blur.';

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Verify documents via the AI/LLM service, then auto-approve or auto-reject
 * the user based on the results. Fire-and-forget — never throws.
 */
export async function triggerAIVerification(
    userId: string,
    documents: VerificationDoc[],
): Promise<void> {
    try {
        const results: { docId: string; type: string; result: AIDocumentResult }[] = [];

        for (const doc of documents) {
            const aiDocType = DOC_TYPE_TO_AI[doc.type] ?? null;
            if (aiDocType === null) {
                // Non-verifiable document (e.g. E_SIGNATURE) — skip AI call
                continue;
            }

            const fileBuffer = await fs.readFile(doc.storagePath);

            const formData = new FormData();
            const extension = path.extname(doc.fileName).toLowerCase();
            const mimeType = extension === '.png'
                ? 'image/png'
                : extension === '.webp'
                    ? 'image/webp'
                    : 'image/jpeg';
            formData.append('file', new Blob([fileBuffer], { type: mimeType }), doc.fileName);

            const response = await fetch(`${env.AI_SERVICE_URL}/api/v1/verify/document?document_type=${aiDocType}`, {
                method: 'POST',
                headers: { 'X-API-Key': env.AI_API_KEY },
                body: formData,
                signal: AbortSignal.timeout(AI_DOCUMENT_TIMEOUT_MS),
            });

            if (!response.ok) {
                console.error(`[KYC] AI verification failed for doc ${doc.id}: HTTP ${response.status}`);

                if (!UNREADABLE_IMAGE_STATUSES.has(response.status)) {
                    throw new AIServiceUnavailableError(`AI service returned HTTP ${response.status}`);
                }

                const message = `${DOC_LABELS[doc.type] ?? 'One of your documents'} could not be read.`;
                results.push({
                    docId: doc.id,
                    type: doc.type,
                    result: {
                        valid: false,
                        document_type: doc.type.toLowerCase(),
                        confidence: 0,
                        extracted_data: {},
                        fraud_indicators: [],
                        message,
                    },
                });
                await prisma.document.update({
                    where: { id: doc.id },
                    data: { status: 'REJECTED', rejectionReason: message },
                });
                continue;
            }

            const result = (await response.json()) as AIDocumentResult;

            console.log(`[KYC] AI result for ${doc.type} (doc ${doc.id}):`, {
                valid: result.valid,
                confidence: result.confidence,
                fraudProbability: result.fraud_probability,
                fraudIndicators: result.fraud_indicators,
                message: result.message,
            });

            // Persist AI results on the document record
            await prisma.document.update({
                where: { id: doc.id },
                data: {
                    aiVerified: result.valid,
                    aiConfidence: result.confidence,
                    aiFraudScore: result.fraud_probability ?? null,
                    aiFraudFlags: result.fraud_indicators ?? [],
                    aiExtractedData: (result.extracted_data as any) ?? undefined,
                    ...(result.valid ? {} : { status: 'REJECTED', rejectionReason: result.message ?? 'AI verification failed' }),
                },
            });

            results.push({ docId: doc.id, type: doc.type, result });
        }

        // Nothing was checked, so there is nothing to hold against the borrower.
        // VERIFIED is the state /kyc/submit accepts again.
        if (results.length === 0) {
            await recordOutage(userId, 'no-verifiable-documents');
            return;
        }

        const allPassed = results.every((r) => r.result.valid);

        console.log(`[KYC] Verification summary for user ${userId}:`, {
            totalDocs: results.length,
            allPassed,
            perDoc: results.map((r) => ({ type: r.type, valid: r.result.valid, confidence: r.result.confidence, message: r.result.message })),
        });

        if (allPassed) {
            const kycLevel = deriveKycLevel(results.map((r) => r.type));

            // The ID front is the identity document; other documents only fill
            // gaps, so a different name on a utility bill cannot override it.
            const ordered = [...results].sort((a, b) =>
                (a.type === 'GOVERNMENT_ID' ? 1 : 0) - (b.type === 'GOVERNMENT_ID' ? 1 : 0));
            const mergedExtractedData = ordered.reduce<Record<string, unknown>>(
                (acc, r) => ({ ...acc, ...r.result.extracted_data }),
                {},
            );

            const identityProfile = await prisma.user.findUnique({
                where: { id: userId },
                select: {
                    legalName: true,
                    dateOfBirth: true,
                    country: true,
                    region: true,
                    province: true,
                    cityTown: true,
                    barangay: true,
                },
            });
            const extractedName = extractedValue(mergedExtractedData, ['name', 'full_name', 'legal_name']);
            const extractedBirthDate = extractedValue(mergedExtractedData, ['date_of_birth', 'birth_date', 'dob']);
            const extractedAddress = extractedValue(mergedExtractedData, ['address', 'full_address']);
            const enteredAddress = identityProfile
                ? [identityProfile.barangay, identityProfile.cityTown, identityProfile.province, identityProfile.region, identityProfile.country]
                    .filter(Boolean)
                    .join(' ')
                : '';
            const identityChecks = {
                nameSimilarity: tokenSimilarity(identityProfile?.legalName, extractedName),
                birthDateMatches: Boolean(
                    identityProfile?.dateOfBirth &&
                    extractedBirthDate &&
                    comparableDate(identityProfile.dateOfBirth) === comparableDate(extractedBirthDate)
                ),
                addressSimilarity: extractedAddress ? tokenSimilarity(enteredAddress, extractedAddress) : null,
                extractedNamePresent: Boolean(extractedName),
                extractedBirthDatePresent: Boolean(extractedBirthDate),
            };
            const identityMismatchReasons = [
                !identityChecks.extractedNamePresent || identityChecks.nameSimilarity < 0.7
                    ? 'The name printed on your ID could not be matched to the name in your profile.'
                    : null,
                !identityChecks.extractedBirthDatePresent || !identityChecks.birthDateMatches
                    ? 'The date of birth on your ID could not be matched to the one you entered.'
                    : null,
                identityChecks.addressSimilarity !== null && identityChecks.addressSimilarity < 0.35
                    ? 'The address on your ID does not match the address in your profile.'
                    : null,
            ].filter((reason): reason is string => Boolean(reason));

            if (identityMismatchReasons.length > 0) {
                const reason = [...identityMismatchReasons, PHOTO_GUIDANCE].join(' ');
                const applied = await applyOutcome(
                    userId,
                    { status: UserStatus.REJECTED, kycRejectionReason: reason },
                    'identity-mismatch',
                );
                if (!applied) return;
                // Force a fresh photo on retry: /kyc/submit only accepts PENDING
                // documents, so leaving these would replay the same bad scan.
                await prisma.document.updateMany({
                    where: { id: { in: results.map((r) => r.docId) } },
                    data: { status: 'REJECTED', rejectionReason: reason },
                });
                await prisma.auditLog.create({
                    data: {
                        userId,
                        action: 'KYC_REJECTED',
                        entity: 'User',
                        entityId: userId,
                        metadata: { identityChecks, reasons: identityMismatchReasons },
                    },
                });
                await notificationService.notify(userId, {
                    type: 'KYC_REJECTED',
                    title: 'Verification Failed',
                    message: reason,
                    metadata: { reasons: identityMismatchReasons },
                });
                return;
            }

            // Fetch user's primary wallet for richer credit scoring
            const primaryWallet = await prisma.wallet.findFirst({
                where: { userId, isPrimary: true, isVerified: true },
            });

            // Fetch user's loan history for returning users
            const loanStats = await prisma.user.findUnique({
                where: { id: userId },
                select: { totalBorrowed: true, totalRepaid: true, activeLoansCount: true, completedLoansCount: true, defaultCount: true },
            });

            let creditScore: number;
            let scoreSource: 'scorer' | 'fallback';
            try {
                // The scorer reads which documents passed from inside extracted_data.
                // Sending only the OCR fields left it with nothing, so the 40-point
                // document component scored zero however much was uploaded.
                const verifiedDocuments = results.reduce<Record<string, unknown>>((acc, r) => {
                    const key = DOC_TYPE_TO_AI[r.type];
                    if (key) acc[key] = { is_verified: r.result.valid, confidence: r.result.confidence };
                    return acc;
                }, {});

                const scorePayload = {
                    user_id: userId,
                    extracted_data: { ...mergedExtractedData, verified_documents: verifiedDocuments },
                    wallet_address: primaryWallet?.address ?? '0x0000000000000000000000000000000000000000',
                    loan_history: loanStats
                        ? {
                              total_loans: (loanStats.completedLoansCount ?? 0) + (loanStats.activeLoansCount ?? 0),
                              repaid_loans: loanStats.completedLoansCount ?? 0,
                              defaulted_loans: loanStats.defaultCount ?? 0,
                              late_payments: 0, // not tracked separately yet
                          }
                        : undefined,
                };

                const scoreRes = await fetch(`${env.AI_SERVICE_URL}/api/v1/score/calculate`, {
                    method: 'POST',
                    headers: { 'X-API-Key': env.AI_API_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify(scorePayload),
                    signal: AbortSignal.timeout(AI_SCORE_TIMEOUT_MS),
                });

                if (!scoreRes.ok) {
                    throw new Error(`Score endpoint returned HTTP ${scoreRes.status}`);
                }
                const scoreData = (await scoreRes.json()) as { score: unknown };
                if (!isUsableScore(scoreData.score)) {
                    throw new Error(`Score endpoint returned an unusable score: ${String(scoreData.score)}`);
                }
                creditScore = scoreData.score;
                scoreSource = 'scorer';
            } catch (scoreErr) {
                console.warn('[KYC] Credit score endpoint failed, using capped fallback:', scoreErr);
                const avgConfidence = results.reduce((sum, r) => sum + r.result.confidence, 0) / results.length;
                creditScore = Math.min(Math.round(avgConfidence * 100), FALLBACK_SCORE_CAP);
                scoreSource = 'fallback';
            }
            const creditTier = deriveTier(creditScore);

            const applied = await applyOutcome(
                userId,
                {
                    status: UserStatus.APPROVED,
                    kycLevel,
                    creditScore,
                    creditTier,
                    kycApprovedAt: new Date(),
                    kycRejectionReason: null,
                },
                'approved',
            );
            if (!applied) return;

            await prisma.auditLog.create({
                data: {
                    userId,
                    action: 'KYC_APPROVED',
                    entity: 'User',
                    entityId: userId,
                    metadata: { creditScore, creditTier, kycLevel, scoreSource, approvedBy: 'ai' },
                },
            });

            await notificationService.notify(userId, {
                type: 'KYC_APPROVED',
                title: '✅ Identity Verified',
                message: 'Your KYC verification has been approved! You can now apply for loans.',
                metadata: { creditScore, creditTier },
            });
        } else {
            const failedDocs = results.filter((r) => !r.result.valid);
            const details = failedDocs
                .map((r) => r.result.message ?? `${DOC_LABELS[r.type] ?? r.type} could not be verified.`)
                .join(' ');
            const reason = `${details} ${PHOTO_GUIDANCE}`.trim();

            const applied = await applyOutcome(
                userId,
                { status: UserStatus.REJECTED, kycRejectionReason: reason },
                'rejected',
            );
            if (!applied) return;

            await prisma.auditLog.create({
                data: {
                    userId,
                    action: 'KYC_REJECTED',
                    entity: 'User',
                    entityId: userId,
                    metadata: { reason, rejectedBy: 'ai' },
                },
            });

            await notificationService.notify(userId, {
                type: 'KYC_REJECTED',
                title: 'Verification Failed',
                message: reason,
                metadata: { reason },
            });
        }
    } catch (error) {
        // A system failure is not a participant rejection
        console.error('[KYC] AI verification error:', error);
        try {
            await recordOutage(userId, error instanceof AIServiceUnavailableError ? 'ai-http-error' : 'system-error-recovery');
        } catch (innerErr) {
            console.error('[KYC] CRITICAL: Failed to record manual review after AI error:', userId, innerErr);
        }
    }
}

// ─── Face Verification ────────────────────────────────────────────────────────

/**
 * Compare a selfie against the user's government ID via the AI service.
 * Stores/updates a SELFIE document record with the result.
 * Throws if no government ID document exists for the user.
 */
export async function verifyFace(
    userId: string,
    selfieBuffer: Buffer,
    selfieFileName: string,
    selfieStoragePath: string,
): Promise<FaceVerifyResult> {
    // Require an existing government ID to compare against
    const govIdDoc = await prisma.document.findFirst({
        where: {
            userId,
            type: 'GOVERNMENT_ID',
            status: { in: ['PENDING', 'APPROVED'] },
        },
        orderBy: { createdAt: 'desc' },
    });

    if (!govIdDoc) {
        throw new Error('GOVERNMENT_ID_REQUIRED');
    }

    // Read the government ID file from disk
    const govIdBuffer = await fs.readFile(govIdDoc.storagePath);

    // Build multipart payload for LLM face endpoint
    const formData = new FormData();
    const selfieExt = path.extname(selfieFileName).toLowerCase();
    const selfimeMime = selfieExt === '.png' ? 'image/png' : 'image/jpeg';
    const govIdExt = path.extname(govIdDoc.fileName).toLowerCase();
    const govIdMime = govIdExt === '.png' ? 'image/png' : 'image/jpeg';

    formData.append('selfie_file', new Blob([new Uint8Array(selfieBuffer)], { type: selfimeMime }), selfieFileName);
    formData.append('government_id_file', new Blob([new Uint8Array(govIdBuffer)], { type: govIdMime }), govIdDoc.fileName);

    // Call LLM face matching endpoint
    const response = await fetch(`${env.AI_SERVICE_URL}/api/v1/verify/face`, {
        method: 'POST',
        headers: { 'X-API-Key': env.AI_API_KEY },
        body: formData,
        signal: AbortSignal.timeout(AI_DOCUMENT_TIMEOUT_MS),
    });

    let passed = false;
    let score = 0;
    let message: string | null = null;

    if (response.ok) {
        const result = (await response.json()) as AIFaceMatchResult;
        passed = result.passed;
        score = result.score;
        message = result.message;
    } else if (response.status === 400 || response.status === 413 || response.status === 422) {
        // The photo is the problem; the service says what to change
        const body = (await response.json().catch(() => ({}))) as { detail?: unknown };
        message = typeof body.detail === 'string'
            ? body.detail
            : 'Your selfie could not be checked. Retake it facing the camera in good light.';
    } else {
        console.error(`[KYC] Face service unavailable for user ${userId}: HTTP ${response.status}`);
        throw new FaceServiceUnavailableError(`Face service returned HTTP ${response.status}`);
    }

    // Upsert the SELFIE document record (replace any previous one)
    const existingSelfie = await prisma.document.findFirst({
        where: { userId, type: 'SELFIE' },
        orderBy: { createdAt: 'desc' },
    });

    let selfieDoc;
    if (existingSelfie && existingSelfie.status !== 'APPROVED') {
        // Delete old file from disk before overwriting
        try { await fs.unlink(existingSelfie.storagePath); } catch { /* already gone */ }

        selfieDoc = await prisma.document.update({
            where: { id: existingSelfie.id },
            data: {
                storagePath: selfieStoragePath,
                fileName: selfieFileName,
                fileSize: selfieBuffer.length,
                faceMatchScore: score,
                faceMatchPassed: passed,
                aiExtractedData: { comparedWithDocumentId: govIdDoc.id },
                status: 'PENDING',
            },
        });
    } else if (!existingSelfie) {
        selfieDoc = await prisma.document.create({
            data: {
                userId,
                type: 'SELFIE',
                fileName: selfieFileName,
                fileSize: selfieBuffer.length,
                mimeType: selfimeMime,
                storagePath: selfieStoragePath,
                status: 'PENDING',
                faceMatchScore: score,
                faceMatchPassed: passed,
                aiExtractedData: { comparedWithDocumentId: govIdDoc.id },
            },
        });
    } else {
        // APPROVED selfie — update only the match fields, keep the stored file
        selfieDoc = await prisma.document.update({
            where: { id: existingSelfie.id },
            data: { faceMatchScore: score, faceMatchPassed: passed, aiExtractedData: { comparedWithDocumentId: govIdDoc.id } },
        });
    }

    await prisma.auditLog.create({
        data: {
            userId,
            action: 'KYC_FACE_VERIFIED',
            entity: 'Document',
            entityId: selfieDoc.id,
            metadata: { passed, score, message },
        },
    });

    return { passed, score, message, selfieDocumentId: selfieDoc.id };
}
