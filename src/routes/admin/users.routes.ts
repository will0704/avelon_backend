import { Hono } from 'hono';
import { prisma } from '../../lib/prisma.js';
import { UserStatus } from '@avelon_capstone/types';

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
    try {
        const status = c.req.query('status');
        const search = c.req.query('search');

        // Validate status against enum to prevent unhandled Prisma errors
        const validStatuses = Object.values(UserStatus);
        if (status && !validStatuses.includes(status as UserStatus)) {
            return c.json({ success: false, message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, 400);
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
    } catch (err) {
        console.error('[admin/users] list error:', err);
        return c.json({ success: false, message: 'Failed to fetch users' }, 500);
    }
});

/**
 * GET /admin/users/:id
 * Get single user details
 */
adminUsersRoutes.get('/:id', async (c) => {
    try {
        const id = c.req.param('id');

        const user = await prisma.user.findUnique({
            where: { id },
            select: userSelect,
        });

        if (!user) {
            return c.json({ success: false, message: 'User not found' }, 404);
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
    } catch (err) {
        console.error('[admin/users] get error:', err);
        return c.json({ success: false, message: 'Failed to fetch user' }, 500);
    }
});

/**
 * PUT /admin/users/:id/status
 * Update user status (suspend / unsuspend)
 */
adminUsersRoutes.put('/:id/status', async (c) => {
    try {
        const id = c.req.param('id');
        const { status } = await c.req.json();

        const validStatuses = [
            'REGISTERED', 'VERIFIED', 'CONNECTED',
            'PENDING_KYC', 'APPROVED', 'REJECTED', 'SUSPENDED',
        ];

        if (!validStatuses.includes(status)) {
            return c.json({ success: false, message: `Invalid status: ${status}` }, 400);
        }

        const user = await prisma.user.findUnique({ where: { id } });
        if (!user) {
            return c.json({ success: false, message: 'User not found' }, 404);
        }

        await prisma.user.update({
            where: { id },
            data: { status },
        });

        return c.json({ success: true, message: 'User status updated' });
    } catch (err) {
        console.error('[admin/users] status update error:', err);
        return c.json({ success: false, message: 'Failed to update user status' }, 500);
    }
});

export { adminUsersRoutes };
