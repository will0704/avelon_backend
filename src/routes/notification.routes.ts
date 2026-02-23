import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../middleware/error.middleware.js';

const notificationRoutes = new Hono();

// Protect ALL notification routes with authentication (OWASP A01)
notificationRoutes.use('*', authMiddleware);

/**
 * GET /notifications
 * List user notifications with pagination and filtering
 */
notificationRoutes.get('/', async (c) => {
    const userId = c.get('userId');
    const unreadOnly = c.req.query('unread') === 'true';
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
    const skip = (page - 1) * limit;

    const where = {
        userId,
        ...(unreadOnly ? { isRead: false } : {}),
    };

    const [notifications, total, unreadCount] = await Promise.all([
        prisma.notification.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            select: {
                id: true,
                type: true,
                title: true,
                message: true,
                metadata: true,
                isRead: true,
                readAt: true,
                createdAt: true,
            },
        }),
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    return c.json({
        success: true,
        data: notifications,
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasMore: skip + limit < total,
            unreadCount,
        },
    });
});

/**
 * PUT /notifications/:id/read
 * Mark a single notification as read
 */
notificationRoutes.put('/:id/read', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');

    // Ensure notification belongs to user (OWASP A01 — IDOR prevention)
    const notification = await prisma.notification.findFirst({
        where: { id, userId },
    });

    if (!notification) {
        throw new NotFoundError('Notification not found');
    }

    if (!notification.isRead) {
        await prisma.notification.update({
            where: { id },
            data: { isRead: true, readAt: new Date() },
        });
    }

    return c.json({
        success: true,
        message: 'Notification marked as read',
    });
});

/**
 * PUT /notifications/read-all
 * Mark all user notifications as read
 */
notificationRoutes.put('/read-all', async (c) => {
    const userId = c.get('userId');

    const result = await prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true, readAt: new Date() },
    });

    return c.json({
        success: true,
        message: 'All notifications marked as read',
        data: { updatedCount: result.count },
    });
});

/**
 * GET /notifications/preferences
 * Get notification preferences
 */
notificationRoutes.get('/preferences', async (c) => {
    const userId = c.get('userId');

    // Upsert: return existing or create default preferences
    let prefs = await prisma.notificationPreference.findUnique({
        where: { userId },
    });

    if (!prefs) {
        prefs = await prisma.notificationPreference.create({
            data: { userId },
        });
    }

    return c.json({
        success: true,
        data: {
            emailLoanUpdates: prefs.emailLoanUpdates,
            emailRepaymentReminders: prefs.emailRepaymentReminders,
            emailLiquidationAlerts: prefs.emailLiquidationAlerts,
            emailMarketingNews: prefs.emailMarketingNews,
            pushLoanUpdates: prefs.pushLoanUpdates,
            pushRepaymentReminders: prefs.pushRepaymentReminders,
            pushLiquidationAlerts: prefs.pushLiquidationAlerts,
        },
    });
});

// Validation schema for preference updates
const updatePreferencesSchema = z.object({
    emailLoanUpdates: z.boolean().optional(),
    emailRepaymentReminders: z.boolean().optional(),
    emailLiquidationAlerts: z.boolean().optional(),
    emailMarketingNews: z.boolean().optional(),
    pushLoanUpdates: z.boolean().optional(),
    pushRepaymentReminders: z.boolean().optional(),
    pushLiquidationAlerts: z.boolean().optional(),
});

/**
 * PUT /notifications/preferences
 * Update notification preferences
 */
notificationRoutes.put('/preferences', zValidator('json', updatePreferencesSchema), async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');

    const prefs = await prisma.notificationPreference.upsert({
        where: { userId },
        create: { userId, ...body },
        update: body,
    });

    return c.json({
        success: true,
        message: 'Preferences updated',
        data: {
            emailLoanUpdates: prefs.emailLoanUpdates,
            emailRepaymentReminders: prefs.emailRepaymentReminders,
            emailLiquidationAlerts: prefs.emailLiquidationAlerts,
            emailMarketingNews: prefs.emailMarketingNews,
            pushLoanUpdates: prefs.pushLoanUpdates,
            pushRepaymentReminders: prefs.pushRepaymentReminders,
            pushLiquidationAlerts: prefs.pushLiquidationAlerts,
        },
    });
});

export { notificationRoutes };
