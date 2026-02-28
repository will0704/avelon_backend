import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../middleware/error.middleware.js';
import { firebaseService } from '../services/firebase.service.js';

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

// Validation schema for device token registration
const deviceTokenSchema = z.object({
    token: z.string().min(1),
    platform: z.enum(['IOS', 'ANDROID', 'WEB']),
});

/**
 * POST /notifications/device-token
 * Register an FCM device token for push notifications
 */
notificationRoutes.post('/device-token', zValidator('json', deviceTokenSchema), async (c) => {
    const userId = c.get('userId');
    const { token, platform } = c.req.valid('json');

    await prisma.deviceToken.upsert({
        where: { token },
        create: { userId, token, platform, isActive: true },
        update: { userId, isActive: true, lastUsedAt: new Date() },
    });

    return c.json({ success: true, message: 'Device token registered' });
});

/**
 * DELETE /notifications/device-token
 * Unregister an FCM device token (e.g. on logout)
 */
notificationRoutes.delete('/device-token', zValidator('json', z.object({ token: z.string().min(1) })), async (c) => {
    const userId = c.get('userId');
    const { token } = c.req.valid('json');

    await prisma.deviceToken.updateMany({
        where: { token, userId },
        data: { isActive: false },
    });

    return c.json({ success: true, message: 'Device token unregistered' });
});

/**
 * POST /notifications/test-push  (dev/debug only)
 * Send a test push to the authenticated user's registered devices
 */
notificationRoutes.post('/test-push', async (c) => {
    const userId = c.get('userId');

    const deviceTokens = await prisma.deviceToken.findMany({
        where: { userId, isActive: true },
        select: { id: true, token: true },
    });

    if (deviceTokens.length === 0) {
        return c.json({ success: false, message: 'No active device tokens found for this user' }, 404);
    }

    const tokens = deviceTokens.map((d) => d.token);
    const invalidTokens = await firebaseService.sendToMultiple(tokens, {
        title: '🔔 Avelon Test Notification',
        body: 'Push notifications are working!',
        data: { type: 'TEST' },
    });

    // Deactivate invalid tokens
    if (invalidTokens.length > 0) {
        await prisma.deviceToken.updateMany({
            where: { token: { in: invalidTokens } },
            data: { isActive: false },
        });
    }

    return c.json({
        success: true,
        message: `Push sent to ${tokens.length - invalidTokens.length} device(s)`,
        data: { sent: tokens.length - invalidTokens.length, invalidRemoved: invalidTokens.length },
    });
});

export { notificationRoutes };
