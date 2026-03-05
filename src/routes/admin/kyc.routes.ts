import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { UserStatus } from '@avelon_capstone/types';
import { notificationService } from '../../services/notification.service.js';
import { NotFoundError, AppError } from '../../middleware/error.middleware.js';

const adminKycRoutes = new Hono();

/**
 * GET /admin/kyc/pending
 * List pending KYC reviews
 */
adminKycRoutes.get('/pending', async (c) => {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
    const skip = (page - 1) * limit;

    const where = { status: UserStatus.PENDING_KYC };

    const [users, total] = await Promise.all([
        prisma.user.findMany({
            where,
            select: {
                id: true,
                email: true,
                name: true,
                status: true,
                kycSubmittedAt: true,
                dateOfBirth: true,
                gender: true,
                civilStatus: true,
                country: true,
                contactNumber: true,
                documents: {
                    select: {
                        id: true,
                        type: true,
                        status: true,
                        fileName: true,
                        aiVerified: true,
                        aiConfidence: true,
                        aiFraudScore: true,
                        aiFraudFlags: true,
                        createdAt: true,
                    },
                    orderBy: { createdAt: 'desc' },
                },
            },
            orderBy: { kycSubmittedAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.user.count({ where }),
    ]);

    return c.json({
        success: true,
        data: users,
        meta: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        },
    });
});

// Validation for KYC approval
const approveSchema = z.object({
    creditScore: z.number().int().min(0).max(100),
    tier: z.enum(['BASIC', 'STANDARD', 'PREMIUM', 'VIP']),
});

/**
 * PUT /admin/kyc/:userId/approve
 * Approve user's KYC — sets user to APPROVED, assigns credit score/tier, approves documents
 */
adminKycRoutes.put('/:userId/approve', zValidator('json', approveSchema), async (c) => {
    const userId = c.req.param('userId');
    const { creditScore, tier } = c.req.valid('json');

    // Validate user exists and is in correct state
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, status: true, email: true },
    });

    if (!user) {
        throw new NotFoundError('User not found');
    }

    if (user.status !== UserStatus.PENDING_KYC) {
        throw new AppError(
            409,
            'INVALID_STATUS',
            `Cannot approve KYC for user in status: ${user.status}. Expected: PENDING_KYC`
        );
    }

    // Update all pending documents to APPROVED
    await prisma.document.updateMany({
        where: { userId, status: 'PENDING' },
        data: { status: 'APPROVED' },
    });

    // Update user status, credit score, and KYC level
    const updated = await prisma.user.update({
        where: { id: userId },
        data: {
            status: UserStatus.APPROVED,
            kycLevel: 'BASIC',
            creditScore,
            creditTier: tier,
            kycApprovedAt: new Date(),
            kycRejectionReason: null, // Clear any previous rejection
        },
        select: {
            id: true,
            email: true,
            status: true,
            kycLevel: true,
            creditScore: true,
            creditTier: true,
            kycApprovedAt: true,
        },
    });

    // Audit log
    await prisma.auditLog.create({
        data: {
            userId,
            action: 'KYC_APPROVED',
            entity: 'User',
            entityId: userId,
            metadata: { creditScore, tier, approvedBy: 'admin' },
        },
    });

    // Send notification + push
    await notificationService.notify(userId, {
        type: 'KYC_APPROVED',
        title: '✅ Identity Verified',
        message: 'Your KYC verification has been approved! You can now apply for loans.',
        metadata: { creditScore, tier },
    });

    return c.json({
        success: true,
        message: 'KYC approved',
        data: updated,
    });
});

// Validation for KYC rejection
const rejectSchema = z.object({
    reason: z.string().min(1, 'Rejection reason is required'),
});

/**
 * PUT /admin/kyc/:userId/reject
 * Reject user's KYC — sets user to REJECTED, marks documents as rejected
 */
adminKycRoutes.put('/:userId/reject', zValidator('json', rejectSchema), async (c) => {
    const userId = c.req.param('userId');
    const { reason } = c.req.valid('json');

    // Validate user exists and is in correct state
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, status: true, email: true },
    });

    if (!user) {
        throw new NotFoundError('User not found');
    }

    if (user.status !== UserStatus.PENDING_KYC) {
        throw new AppError(
            409,
            'INVALID_STATUS',
            `Cannot reject KYC for user in status: ${user.status}. Expected: PENDING_KYC`
        );
    }

    // Update all pending documents to REJECTED
    await prisma.document.updateMany({
        where: { userId, status: 'PENDING' },
        data: { status: 'REJECTED', rejectionReason: reason },
    });

    // Update user status
    const updated = await prisma.user.update({
        where: { id: userId },
        data: {
            status: UserStatus.REJECTED,
            kycRejectionReason: reason,
        },
        select: {
            id: true,
            email: true,
            status: true,
            kycRejectionReason: true,
        },
    });

    // Audit log
    await prisma.auditLog.create({
        data: {
            userId,
            action: 'KYC_REJECTED',
            entity: 'User',
            entityId: userId,
            metadata: { reason, rejectedBy: 'admin' },
        },
    });

    // Send notification + push
    await notificationService.notify(userId, {
        type: 'KYC_REJECTED',
        title: '❌ Verification Failed',
        message: `Your KYC verification was rejected: ${reason}. Please re-submit your documents.`,
        metadata: { reason },
    });

    return c.json({
        success: true,
        message: 'KYC rejected',
        data: updated,
    });
});

export { adminKycRoutes };
