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
            const fileBuffer = await fs.readFile(doc.storagePath);

            const formData = new FormData();
            formData.append('file', new Blob([fileBuffer]), doc.fileName);
            formData.append('document_type', doc.type.toLowerCase());

            const response = await fetch(`${env.AI_SERVICE_URL}/api/v1/verify/document`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                console.error(`[KYC] AI verification failed for doc ${doc.id}: HTTP ${response.status}`);
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

        // If no results at all (AI unreachable for every doc), bail out silently
        if (results.length === 0) return;

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
        // Fire-and-forget — don't throw
    }
}
