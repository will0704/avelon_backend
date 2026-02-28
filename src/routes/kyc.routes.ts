import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { NotFoundError, ValidationError, ForbiddenError, AppError } from '../middleware/error.middleware.js';
import { UserStatus } from '@avelon_capstone/types';
import path from 'path';
import fs from 'fs/promises';

const kycRoutes = new Hono();

// Protect ALL KYC routes with authentication (OWASP A01)
kycRoutes.use('*', authMiddleware);

// Allowed document types and MIME types
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const VALID_DOC_TYPES = ['GOVERNMENT_ID', 'GOVERNMENT_ID_BACK', 'E_SIGNATURE', 'PROOF_OF_INCOME', 'PROOF_OF_ADDRESS', 'SELFIE'] as const;

/**
 * Ensure the uploads directory exists
 */
async function ensureUploadDir(userId: string): Promise<string> {
    const uploadDir = path.resolve(env.STORAGE_PATH, 'kyc', userId);
    await fs.mkdir(uploadDir, { recursive: true });
    return uploadDir;
}

/**
 * GET /kyc/status
 * Get KYC status for the authenticated user
 */
kycRoutes.get('/status', async (c) => {
    const userId = c.get('userId');

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            status: true,
            kycLevel: true,
            kycSubmittedAt: true,
            kycApprovedAt: true,
            kycRejectionReason: true,
            creditScore: true,
            creditTier: true,
        },
    });

    if (!user) {
        throw new NotFoundError('User not found');
    }

    // Get documents grouped by type
    const documents = await prisma.document.findMany({
        where: { userId },
        select: {
            id: true,
            type: true,
            status: true,
            fileName: true,
            aiVerified: true,
            aiConfidence: true,
            rejectionReason: true,
            createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
    });

    // Build document status map
    type DocItem = typeof documents[number];
    const docStatus = {
        GOVERNMENT_ID: documents.find((d: DocItem) => d.type === 'GOVERNMENT_ID') ?? null,
        GOVERNMENT_ID_BACK: documents.find((d: DocItem) => d.type === 'GOVERNMENT_ID_BACK') ?? null,
        E_SIGNATURE: documents.find((d: DocItem) => d.type === 'E_SIGNATURE') ?? null,
        PROOF_OF_INCOME: documents.find((d: DocItem) => d.type === 'PROOF_OF_INCOME') ?? null,
        PROOF_OF_ADDRESS: documents.find((d: DocItem) => d.type === 'PROOF_OF_ADDRESS') ?? null,
        SELFIE: documents.find((d: DocItem) => d.type === 'SELFIE') ?? null,
    };

    return c.json({
        success: true,
        data: {
            level: user.kycLevel,
            status: user.status,
            submittedAt: user.kycSubmittedAt,
            approvedAt: user.kycApprovedAt,
            rejectionReason: user.kycRejectionReason,
            creditScore: user.creditScore,
            creditTier: user.creditTier,
            documents: docStatus,
            allDocuments: documents,
        },
    });
});

// Validation for KYC profile info
const kycProfileSchema = z.object({
    dateOfBirth: z.string().min(1, 'Date of birth is required'),
    gender: z.string().min(1, 'Gender is required'),
    civilStatus: z.string().min(1, 'Civil status is required'),
    educationLevel: z.string().min(1, 'Education level is required'),
    country: z.string().min(1, 'Country is required'),
    region: z.string().optional(),
    province: z.string().optional(),
    cityTown: z.string().optional(),
    barangay: z.string().optional(),
    contactNumber: z.string().min(1, 'Contact number is required'),
    secondaryEmail: z.string().email('Must be a valid email').optional(),
});

/**
 * POST /kyc/profile
 * Submit basic information and contact information for KYC
 */
kycRoutes.post('/profile', zValidator('json', kycProfileSchema), async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { status: true },
    });

    if (!user) {
        throw new NotFoundError('User not found');
    }

    // Only allow VERIFIED or REJECTED users to submit profile info
    if (user.status !== UserStatus.VERIFIED && user.status !== UserStatus.REJECTED) {
        throw new AppError(
            409,
            'INVALID_STATUS',
            `Cannot submit KYC profile info in current status: ${user.status}`
        );
    }

    // Update user with KYC profile data
    const updated = await prisma.user.update({
        where: { id: userId },
        data: {
            dateOfBirth: body.dateOfBirth,
            gender: body.gender,
            civilStatus: body.civilStatus,
            educationLevel: body.educationLevel,
            country: body.country,
            region: body.region ?? null,
            province: body.province ?? null,
            cityTown: body.cityTown ?? null,
            barangay: body.barangay ?? null,
            contactNumber: body.contactNumber,
            secondaryEmail: body.secondaryEmail ?? null,
        },
        select: {
            id: true,
            dateOfBirth: true,
            gender: true,
            civilStatus: true,
            educationLevel: true,
            country: true,
            region: true,
            province: true,
            cityTown: true,
            barangay: true,
            contactNumber: true,
            secondaryEmail: true,
        },
    });

    // Log audit
    await prisma.auditLog.create({
        data: {
            userId,
            action: 'KYC_PROFILE_SUBMITTED',
            entity: 'User',
            entityId: userId,
            metadata: { fields: Object.keys(body) },
        },
    });

    return c.json({
        success: true,
        message: 'KYC profile information saved',
        data: updated,
    });
});

/**
 * GET /kyc/profile
 * Get KYC profile information for the authenticated user
 */
kycRoutes.get('/profile', async (c) => {
    const userId = c.get('userId');

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            dateOfBirth: true,
            gender: true,
            civilStatus: true,
            educationLevel: true,
            country: true,
            region: true,
            province: true,
            cityTown: true,
            barangay: true,
            contactNumber: true,
            secondaryEmail: true,
        },
    });

    if (!user) {
        throw new NotFoundError('User not found');
    }

    return c.json({
        success: true,
        data: user,
    });
});

/**
 * POST /kyc/documents
 * Upload a KYC document (multipart/form-data)
 */
kycRoutes.post('/documents', async (c) => {
    const userId = c.get('userId');

    // Parse multipart form data
    const body = await c.req.parseBody();
    const file = body['file'];
    const docType = body['type'] as string;

    // Validate document type
    if (!docType || !VALID_DOC_TYPES.includes(docType as any)) {
        throw new ValidationError(
            `Invalid document type. Must be one of: ${VALID_DOC_TYPES.join(', ')}`
        );
    }

    // Validate file
    if (!file || !(file instanceof File)) {
        throw new ValidationError('File is required. Send as multipart/form-data with field name "file".');
    }

    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
        throw new ValidationError(
            `Unsupported file type "${file.type}". Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`
        );
    }

    if (file.size > MAX_FILE_SIZE) {
        throw new ValidationError(`File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.`);
    }

    // Check if user already has a PENDING or APPROVED document of this type
    const existingDoc = await prisma.document.findFirst({
        where: {
            userId,
            type: docType as any,
            status: { in: ['PENDING', 'APPROVED'] },
        },
    });

    if (existingDoc) {
        throw new AppError(
            409,
            'ALREADY_EXISTS',
            `You already have a ${existingDoc.status.toLowerCase()} ${docType} document. Delete it first to upload a new one.`
        );
    }

    // Save file to disk
    const uploadDir = await ensureUploadDir(userId);
    const ext = path.extname(file.name) || '.bin';
    const safeFileName = `${docType}_${Date.now()}${ext}`;
    const filePath = path.join(uploadDir, safeFileName);

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    // Create document record
    const document = await prisma.document.create({
        data: {
            userId,
            type: docType as any,
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type,
            storagePath: filePath,
            status: 'PENDING',
        },
        select: {
            id: true,
            type: true,
            status: true,
            fileName: true,
            fileSize: true,
            mimeType: true,
            createdAt: true,
        },
    });

    // Log audit
    await prisma.auditLog.create({
        data: {
            userId,
            action: 'KYC_DOCUMENT_UPLOAD',
            entity: 'Document',
            entityId: document.id,
            metadata: { type: docType, fileName: file.name, fileSize: file.size },
        },
    });

    return c.json({
        success: true,
        message: 'Document uploaded successfully',
        data: document,
    }, 201);
});

/**
 * GET /kyc/documents
 * List all uploaded KYC documents for the user
 */
kycRoutes.get('/documents', async (c) => {
    const userId = c.get('userId');

    const documents = await prisma.document.findMany({
        where: { userId },
        select: {
            id: true,
            type: true,
            status: true,
            fileName: true,
            fileSize: true,
            mimeType: true,
            aiVerified: true,
            aiConfidence: true,
            aiFraudScore: true,
            aiFraudFlags: true,
            rejectionReason: true,
            createdAt: true,
            updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
    });

    return c.json({
        success: true,
        data: documents,
        meta: { total: documents.length },
    });
});

/**
 * DELETE /kyc/documents/:id
 * Delete a pending KYC document
 */
kycRoutes.delete('/documents/:id', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');

    // Find document belonging to user (IDOR protection)
    const document = await prisma.document.findFirst({
        where: { id, userId },
    });

    if (!document) {
        throw new NotFoundError('Document not found');
    }

    // Only allow deletion of PENDING or REJECTED documents
    if (document.status === 'APPROVED') {
        throw new ForbiddenError('Cannot delete an approved document');
    }

    // Delete file from disk
    try {
        await fs.unlink(document.storagePath);
    } catch {
        // File may already be deleted — continue
    }

    // Delete DB record
    await prisma.document.delete({ where: { id } });

    // Log audit
    await prisma.auditLog.create({
        data: {
            userId,
            action: 'KYC_DOCUMENT_DELETE',
            entity: 'Document',
            entityId: id,
            metadata: { type: document.type, fileName: document.fileName },
        },
    });

    return c.json({
        success: true,
        message: 'Document deleted',
    });
});

// Validation for KYC submission
const submitKycSchema = z.object({
    documentIds: z.array(z.string()).min(1, 'At least one document ID is required').optional(),
});

/**
 * POST /kyc/submit
 * Submit KYC documents for AI verification
 */
kycRoutes.post('/submit', zValidator('json', submitKycSchema), async (c) => {
    const userId = c.get('userId');

    // Verify user is in the right state for KYC submission
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { status: true, kycLevel: true },
    });

    if (!user) {
        throw new NotFoundError('User not found');
    }

    if (user.status === UserStatus.APPROVED || user.status === UserStatus.CONNECTED) {
        throw new AppError(409, 'KYC_ALREADY_APPROVED', 'KYC is already approved');
    }

    if (user.status === UserStatus.PENDING_KYC) {
        throw new AppError(409, 'KYC_ALREADY_SUBMITTED', 'KYC is already pending review');
    }

    if (user.status === UserStatus.REGISTERED) {
        throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email before submitting KYC');
    }

    // Get user's pending documents
    const documents = await prisma.document.findMany({
        where: { userId, status: 'PENDING' },
        select: {
            id: true,
            type: true,
            storagePath: true,
            fileName: true,
        },
    });

    // Require at least a government ID
    const hasGovId = documents.some((d: { type: string }) => d.type === 'GOVERNMENT_ID');
    if (!hasGovId) {
        throw new ValidationError('A government ID document is required for KYC submission');
    }

    // Update user status to pending KYC
    await prisma.user.update({
        where: { id: userId },
        data: {
            status: UserStatus.PENDING_KYC,
            kycSubmittedAt: new Date(),
        },
    });

    // Create notification for user
    await prisma.notification.create({
        data: {
            userId,
            type: 'KYC_APPROVED', // Using closest available enum — maps to "KYC submitted" contextually
            title: 'KYC Submitted',
            message: 'Your KYC documents have been submitted for verification. You will be notified once the review is complete.',
            metadata: { documentCount: documents.length },
        },
    });

    // Attempt to call AI service asynchronously (fire-and-forget)
    // The actual verification result will be handled by admin review or AI callback
    triggerAIVerification(userId, documents).catch((err) => {
        console.error('[KYC] AI verification trigger failed:', err);
    });

    // Log audit
    await prisma.auditLog.create({
        data: {
            userId,
            action: 'KYC_SUBMIT',
            entity: 'User',
            entityId: userId,
            metadata: { documentIds: documents.map((d: { id: string }) => d.id) },
        },
    });

    return c.json({
        success: true,
        message: 'KYC submitted for verification',
        data: {
            status: 'PENDING_KYC',
            submittedAt: new Date().toISOString(),
            documentCount: documents.length,
        },
    });
});

/**
 * Trigger AI verification via the LLM service (fire-and-forget)
 * Results are stored back on the documents and user record
 */
async function triggerAIVerification(
    userId: string,
    documents: { id: string; type: string; storagePath: string; fileName: string }[]
) {
    try {
        for (const doc of documents) {
            // Read file and send to AI service
            const fileBuffer = await fs.readFile(doc.storagePath);

            const formData = new FormData();
            formData.append('file', new Blob([fileBuffer]), doc.fileName);
            formData.append('document_type', doc.type.toLowerCase());

            const response = await fetch(`${env.AI_SERVICE_URL}/api/v1/verify/document`, {
                method: 'POST',
                body: formData,
            });

            if (response.ok) {
                const result = await response.json() as {
                    is_authentic: boolean;
                    confidence: number;
                    fraud_score: number;
                    fraud_flags: string[];
                    extracted_data: Record<string, unknown>;
                };

                // Update document with AI results
                await prisma.document.update({
                    where: { id: doc.id },
                    data: {
                        aiVerified: result.is_authentic,
                        aiConfidence: result.confidence,
                        aiFraudScore: result.fraud_score,
                        aiFraudFlags: result.fraud_flags ?? [],
                        aiExtractedData: (result.extracted_data as any) ?? undefined,
                    },
                });
            } else {
                console.error(`[KYC] AI verification failed for doc ${doc.id}:`, response.status);
            }
        }
    } catch (error) {
        console.error('[KYC] AI service error:', error);
        // Don't throw — this is fire-and-forget. Admin can still manually review.
    }
}

export { kycRoutes };
