import { Hono } from 'hono';
import { prisma } from '../../lib/prisma.js';
import { UserStatus } from '../../types/index.js';
import { NotFoundError, ValidationError } from '../../middleware/error.middleware.js';

const adminUsersRoutes = new Hono();

/** Fields exposed to the admin panel (matching UserProfile type). */
const userSelect = {
    id: true,
    email: true,
    emailVerified: true,
    name: true,
    role: true,
    status: true,
    kycLevel: true,
    creditScore: true,
    creditTier: true,
    legalName: true,
    totalBorrowed: true,
    totalRepaid: true,
    activeLoansCount: true,
    createdAt: true,
} as const;

/**
 * GET /admin/users
 * List all users (with optional status filter & search)
 */
adminUsersRoutes.get('/', async (c) => {
    const status = c.req.query('status');
    const search = c.req.query('search');

    // Validate status against enum to prevent unhandled Prisma errors
    const validStatuses = Object.values(UserStatus);
    if (status && !validStatuses.includes(status as UserStatus)) {
        throw new ValidationError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }

    const where: Record<string, unknown> = {};

    if (status) {
        where.status = status;
    }
    if (search) {
        where.OR = [
            { email: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            // legalName is AES-256-GCM encrypted at rest — plaintext search is not possible
        ];
    }

    const users = await prisma.user.findMany({
        where,
        select: userSelect,
        orderBy: { createdAt: 'desc' },
    });

    // Map Prisma Decimal → number and emailVerified → boolean for the frontend
    const mapped = users.map((u) => ({
        ...u,
        emailVerified: !!u.emailVerified,
        totalBorrowed: Number(u.totalBorrowed),
        totalRepaid: Number(u.totalRepaid),
    }));

    return c.json({ success: true, data: { users: mapped } });
});

/**
 * GET /admin/users/:id
 * Get single user details
 */
adminUsersRoutes.get('/:id', async (c) => {
    const id = c.req.param('id');

    const user = await prisma.user.findUnique({
        where: { id },
        select: userSelect,
    });

    if (!user) {
        throw new NotFoundError('User not found');
    }

    return c.json({
        success: true,
        data: {
            ...user,
            emailVerified: !!user.emailVerified,
            totalBorrowed: Number(user.totalBorrowed),
            totalRepaid: Number(user.totalRepaid),
        },
    });
});

/**
 * PUT /admin/users/:id/status
 * { status: 'SUSPENDED' } suspends; { status: 'RESTORED' } puts back the status
 * the user had before. Nothing else can be set here — KYC and wallet status only
 * change through their own flows.
 */
adminUsersRoutes.put('/:id/status', async (c) => {
    const id = c.req.param('id');
    const adminId = c.get('userId');
    const body = await c.req.json().catch(() => null);
    const requested = body?.status;

    if (requested !== 'SUSPENDED' && requested !== 'RESTORED') {
        throw new ValidationError('Status must be SUSPENDED or RESTORED');
    }
    if (id === adminId) {
        throw new ValidationError('You cannot change your own status');
    }

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
        throw new NotFoundError('User not found');
    }

    if (requested === 'SUSPENDED') {
        if (user.status === UserStatus.SUSPENDED) {
            throw new ValidationError('User is already suspended');
        }
        await prisma.user.update({ where: { id }, data: { status: UserStatus.SUSPENDED } });
        await prisma.session.deleteMany({ where: { userId: id } });
        await prisma.auditLog.create({
            data: {
                userId: adminId,
                action: 'USER_SUSPENDED',
                entity: 'User',
                entityId: id,
                metadata: { previousStatus: user.status, by: adminId },
            },
        });
        return c.json({ success: true, message: 'User suspended' });
    }

    if (user.status !== UserStatus.SUSPENDED) {
        throw new ValidationError('User is not suspended');
    }

    const lastSuspension = await prisma.auditLog.findFirst({
        where: { action: 'USER_SUSPENDED', entityId: id },
        orderBy: { createdAt: 'desc' },
    });
    const restored = restoredStatus(
        (lastSuspension?.metadata as { previousStatus?: string } | null)?.previousStatus,
        user,
    );

    await prisma.user.update({ where: { id }, data: { status: restored } });
    await prisma.auditLog.create({
        data: {
            userId: adminId,
            action: 'USER_RESTORED',
            entity: 'User',
            entityId: id,
            metadata: { restoredStatus: restored, by: adminId },
        },
    });

    return c.json({ success: true, message: 'User restored', data: { status: restored } });
});

/**
 * The status to come back to. A verification that was in flight when the user
 * was suspended is not running any more, so that user resubmits from VERIFIED.
 */
function restoredStatus(
    previous: string | undefined,
    user: { emailVerified: Date | null; kycApprovedAt: Date | null },
): UserStatus {
    if (previous === UserStatus.PENDING_KYC) return UserStatus.VERIFIED;
    if (previous && previous !== UserStatus.SUSPENDED && (Object.values(UserStatus) as string[]).includes(previous)) {
        return previous as UserStatus;
    }
    // No record of the suspension: fall back to what the account has proven
    if (user.kycApprovedAt) return UserStatus.APPROVED;
    if (user.emailVerified) return UserStatus.VERIFIED;
    return UserStatus.REGISTERED;
}

export { adminUsersRoutes };
