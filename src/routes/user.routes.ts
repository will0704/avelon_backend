import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import fs from 'fs/promises';
import { prisma } from '../lib/prisma.js';
import { UserStatus, LoanStatus } from '../types/index.js';

const userRoutes = new Hono();

// Validation schemas
const updateProfileSchema = z.object({
    name: z.string().min(2).optional(),
    phone: z.string().optional(),
    avatar: z.string().url()
        .refine(
            (url) => {
                try {
                    const parsed = new URL(url);
                    // OWASP A10 — Only allow HTTPS, block internal IPs
                    if (parsed.protocol !== 'https:') return false;
                    const host = parsed.hostname;
                    // Block private/internal IPs
                    if (
                        host === 'localhost' ||
                        host.startsWith('127.') ||
                        host.startsWith('10.') ||
                        host.startsWith('192.168.') ||
                        host.startsWith('172.') ||
                        host === '0.0.0.0' ||
                        host.startsWith('169.254.') ||
                        host.endsWith('.local')
                    ) {
                        return false;
                    }
                    return true;
                } catch {
                    return false;
                }
            },
            'Avatar URL must be a valid HTTPS URL pointing to a public host'
        )
        .optional(),
});

/**
 * GET /users/me
 * Get current user profile
 */
userRoutes.get('/me', authMiddleware, async (c) => {
    const userId = c.get('userId');

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            avatar: true,
            role: true,
            status: true,
            kycLevel: true,
            creditScore: true,
            creditTier: true,
            legalName: true,
            address: true,
            employmentType: true,
            totalBorrowed: true,
            totalRepaid: true,
            activeLoansCount: true,
            completedLoansCount: true,
            createdAt: true,
            lastLoginAt: true,
            wallets: {
                select: {
                    id: true,
                    address: true,
                    isPrimary: true,
                    isVerified: true,
                    label: true,
                },
            },
        },
    });

    if (!user) {
        return c.json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'User not found' },
        }, 404);
    }

    return c.json({
        success: true,
        data: user,
    });
});

/**
 * PUT /users/me
 * Update current user profile
 */
userRoutes.put('/me', authMiddleware, zValidator('json', updateProfileSchema), async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');

    const user = await prisma.user.update({
        where: { id: userId },
        data: body,
        select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            avatar: true,
        },
    });

    // Log audit
    await prisma.auditLog.create({
        data: {
            userId,
            action: 'PROFILE_UPDATED',
            entity: 'User',
            entityId: userId,
            metadata: { fields: Object.keys(body) },
        },
    });

    return c.json({
        success: true,
        message: 'Profile updated successfully',
        data: user,
    });
});

/**
 * GET /users/me/stats
 * Get user statistics
 */
userRoutes.get('/me/stats', authMiddleware, async (c) => {
    const userId = c.get('userId');

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            totalBorrowed: true,
            totalRepaid: true,
            activeLoansCount: true,
            completedLoansCount: true,
            defaultCount: true,
            creditScore: true,
            creditTier: true,
        },
    });

    // Get additional stats
    const [activeLoans, loanHistory] = await Promise.all([
        prisma.loan.findMany({
            where: { userId, status: LoanStatus.ACTIVE },
            select: {
                id: true,
                principal: true,
                principalOwed: true,
                interestOwed: true,
                dueDate: true,
            },
        }),
        prisma.loan.count({
            where: { userId },
        }),
    ]);

    // Calculate totals
    const totalOutstanding = activeLoans.reduce(
        (sum, loan) => sum + Number(loan.principalOwed) + Number(loan.interestOwed),
        0
    );

    return c.json({
        success: true,
        data: {
            ...user,
            totalOutstanding: totalOutstanding.toFixed(4),
            activeLoans: activeLoans.length,
            totalLoans: loanHistory,
        },
    });
});

/**
 * DELETE /users/me
 * Delete user account (soft delete / anonymize)
 */
userRoutes.delete('/me', authMiddleware, async (c) => {
    const userId = c.get('userId');

    // An application under review would otherwise be approved for an erased user
    const openLoans = await prisma.loan.count({
        where: {
            userId,
            status: { in: [LoanStatus.PENDING_APPROVAL, LoanStatus.PENDING_COLLATERAL, LoanStatus.COLLATERAL_DEPOSITED, LoanStatus.ACTIVE] },
        },
    });

    if (openLoans > 0) {
        return c.json({
            success: false,
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Cancel or finish your open loans before deleting your account',
            },
        }, 400);
    }

    // KYC images go first; the rows that point at them go with them
    const documents = await prisma.document.findMany({ where: { userId }, select: { id: true, storagePath: true } });
    for (const doc of documents) {
        try { await fs.unlink(doc.storagePath); } catch { /* already gone */ }
    }
    await prisma.document.deleteMany({ where: { userId } });

    // Loan history still points at these wallets, so they stay as rows, but the
    // address is released so the owner can link it to a new account.
    const wallets = await prisma.wallet.findMany({ where: { userId }, select: { id: true } });
    for (const wallet of wallets) {
        await prisma.wallet.update({
            where: { id: wallet.id },
            data: { address: `deleted:${wallet.id}`, isVerified: false, isPrimary: false },
        });
    }

    // Anonymize user data (soft delete for compliance)
    await prisma.user.update({
        where: { id: userId },
        data: {
            email: `deleted_${userId}@avelon.finance`,
            name: 'Deleted User',
            phone: null,
            avatar: null,
            passwordHash: null,
            status: UserStatus.SUSPENDED,
            legalName: null,
            address: null,
            monthlyIncome: null,
            employmentType: null,
            birthDate: null,
            dateOfBirth: null,
            gender: null,
            civilStatus: null,
            educationLevel: null,
            country: null,
            region: null,
            province: null,
            cityTown: null,
            barangay: null,
            contactNumber: null,
            secondaryEmail: null,
            idType: null,
            kycRejectionReason: null,
        },
    });

    await prisma.session.deleteMany({
        where: { userId },
    });

    await prisma.auditLog.create({
        data: {
            userId,
            action: 'ACCOUNT_DELETED',
            entity: 'User',
            entityId: userId,
            metadata: { documentsRemoved: documents.length, walletsReleased: wallets.length },
        },
    });

    return c.json({
        success: true,
        message: 'Account deleted successfully',
    });
});

export { userRoutes };
