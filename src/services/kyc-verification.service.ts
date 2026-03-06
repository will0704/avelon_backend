import fs from 'fs/promises';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { UserStatus } from '@avelon_capstone/types';
import { KYCLevel } from '../generated/prisma/enums.js';
import { notificationService } from '../services/notification.service.js';

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
    GOVERNMENT_ID_BACK: 'government_id',   // back of same ID — verify as government_id
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

        if (allPassed) {
            const avgConfidence = results.reduce((sum, r) => sum + r.result.confidence, 0) / results.length;
            const creditScore = Math.round(avgConfidence * 100);
            const creditTier = deriveTier(creditScore);
            const kycLevel = deriveKycLevel(results.map((r) => r.type));

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
            await notificationService.notify(userId, {
                type: 'KYC_REJECTED',
                title: '❌ Verification Failed',
                message: `${reason}`,
                metadata: { reason },
            });
        } catch (innerErr) {
            console.error('[KYC] Failed to reject user after error:', innerErr);
        }
    }
}
