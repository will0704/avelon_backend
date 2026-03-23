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

// ─── Tier mapping ─────────────────────────────────────────────────────────────

function deriveTier(score: number): string {
    if (score >= 80) return 'VIP';
    if (score >= 60) return 'PREMIUM';
    if (score >= 40) return 'STANDARD';
    return 'BASIC';
}

function deriveKycLevel(docTypes: string[]): KYCLevel {
    const has = (t: string) => docTypes.includes(t);
    if (has('GOVERNMENT_ID') && has('PROOF_OF_INCOME') && has('PROOF_OF_ADDRESS')) return KYCLevel.ENHANCED;
    if (has('GOVERNMENT_ID') && has('PROOF_OF_INCOME')) return KYCLevel.STANDARD;
    return KYCLevel.BASIC;
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
            const mimeType = doc.fileName.endsWith('.png') ? 'image/png' : 'image/jpeg';
            formData.append('file', new Blob([fileBuffer], { type: mimeType }), doc.fileName);

            const response = await fetch(`${env.AI_SERVICE_URL}/api/v1/verify/document?document_type=${aiDocType}`, {
                method: 'POST',
                headers: { 'X-API-Key': env.AI_API_KEY },
                body: formData,
            });

            if (!response.ok) {
                const errorReason = `AI service returned HTTP ${response.status}`;
                console.error(`[KYC] AI verification failed for doc ${doc.id}: ${errorReason}`);

                // Mark document as REJECTED so it doesn't stay PENDING forever
                await prisma.document.update({
                    where: { id: doc.id },
                    data: {
                        status: 'REJECTED',
                        rejectionReason: `${errorReason} — please re-upload a clearer document`,
                    },
                });

                // Track as a failed result so the user gets auto-rejected
                results.push({
                    docId: doc.id,
                    type: doc.type,
                    result: {
                        valid: false,
                        document_type: doc.type.toLowerCase(),
                        confidence: 0,
                        extracted_data: {},
                        fraud_indicators: [],
                        message: errorReason,
                    },
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

        // If no results at all (AI completely unreachable), still reject
        if (results.length === 0) {
            const reason = 'AI verification service was unreachable for all documents';
            await prisma.user.update({
                where: { id: userId },
                data: { status: UserStatus.REJECTED, kycRejectionReason: reason },
            });
            await prisma.auditLog.create({
                data: { userId, action: 'KYC_REJECTED', entity: 'User', entityId: userId, metadata: { reason, rejectedBy: 'ai' } },
            });
            await notificationService.notify(userId, {
                type: 'KYC_REJECTED',
                title: '❌ Verification Failed',
                message: `${reason}. Please try again later.`,
                metadata: { reason },
            });
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

            // Merge extracted data from all verified documents
            const mergedExtractedData = results.reduce<Record<string, unknown>>(
                (acc, r) => ({ ...acc, ...r.result.extracted_data }),
                {},
            );

            // Fetch user's primary wallet for richer credit scoring
            const primaryWallet = await prisma.wallet.findFirst({
                where: { userId, isPrimary: true, isVerified: true },
            });

            // Fetch user's loan history for returning users
            const loanStats = await prisma.user.findUnique({
                where: { id: userId },
                select: { totalBorrowed: true, totalRepaid: true, activeLoansCount: true, completedLoansCount: true, defaultCount: true },
            });

            // Call LLM credit scoring endpoint for an accurate, multi-factor score
            let creditScore: number;
            let creditTier: string;
            try {
                const scorePayload = {
                    user_id: userId,
                    extracted_data: mergedExtractedData,
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
                });

                if (scoreRes.ok) {
                    const scoreData = (await scoreRes.json()) as { score: number; tier: string | null };
                    creditScore = scoreData.score;
                    creditTier = scoreData.tier?.toUpperCase() ?? deriveTier(scoreData.score);
                } else {
                    throw new Error(`Score endpoint returned HTTP ${scoreRes.status}`);
                }
            } catch (scoreErr) {
                // Fall back to confidence-based score so KYC approval still completes
                console.warn('[KYC] Credit score endpoint failed, using fallback:', scoreErr);
                const avgConfidence = results.reduce((sum, r) => sum + r.result.confidence, 0) / results.length;
                creditScore = Math.round(avgConfidence * 100);
                creditTier = deriveTier(creditScore);
            }

            await prisma.user.update({
                where: { id: userId },
                data: {
                    status: UserStatus.APPROVED,
                    kycLevel,
                    creditScore,
                    creditTier,
                    kycApprovedAt: new Date(),
                    kycRejectionReason: null,
                },
            });

            await prisma.auditLog.create({
                data: {
                    userId,
                    action: 'KYC_APPROVED',
                    entity: 'User',
                    entityId: userId,
                    metadata: { creditScore, creditTier, kycLevel, approvedBy: 'ai' },
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
            const reason = failedDocs
                .map((r) => r.result.message ?? `${r.type} failed verification`)
                .join('; ');

            await prisma.user.update({
                where: { id: userId },
                data: {
                    status: UserStatus.REJECTED,
                    kycRejectionReason: reason,
                },
            });

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
                title: '❌ Verification Failed',
                message: `Your KYC verification was rejected: ${reason}. Please re-submit your documents.`,
                metadata: { reason },
            });
        }
    } catch (error) {
        console.error('[KYC] AI verification error:', error);
        // Still reject the user so they don't stay stuck in PENDING_KYC
        try {
            const reason = 'Verification failed due to a system error. Please try again.';
            await prisma.user.update({
                where: { id: userId },
                data: { status: UserStatus.REJECTED, kycRejectionReason: reason },
            });
            await prisma.auditLog.create({
                data: {
                    userId,
                    action: 'KYC_REJECTED',
                    entity: 'User',
                    entityId: userId,
                    metadata: { reason, rejectedBy: 'system-error-recovery' },
                },
            });
            await notificationService.notify(userId, {
                type: 'KYC_REJECTED',
                title: '❌ Verification Failed',
                message: `${reason}`,
                metadata: { reason },
            });
        } catch (innerErr) {
            // Recovery also failed — user may be stuck in PENDING_KYC.
            // This requires manual admin intervention.
            console.error('[KYC] CRITICAL: Failed to reject user after AI error. User stuck in PENDING_KYC:', userId, innerErr);
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
    });

    let passed = false;
    let score = 0;
    let message: string | null = null;

    if (response.ok) {
        const result = (await response.json()) as AIFaceMatchResult;
        passed = result.passed;
        score = result.score;
        message = result.message;
    } else {
        message = `Face verification service returned HTTP ${response.status}`;
        console.error(`[KYC] Face match failed for user ${userId}: ${message}`);
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
            },
        });
    } else {
        // APPROVED selfie — update only the match fields, keep the stored file
        selfieDoc = await prisma.document.update({
            where: { id: existingSelfie.id },
            data: { faceMatchScore: score, faceMatchPassed: passed },
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
