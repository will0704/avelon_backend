import { prisma } from '../lib/prisma.js';
import { firebaseService } from './firebase.service.js';

interface NotifyPayload {
    type: string;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
}

/**
 * NotificationService
 * Centralized helper for creating in-app notifications + sending push notifications.
 * Uses fire-and-forget for push delivery so API responses are never blocked.
 */
class NotificationService {
    /**
     * Create an in-app notification record and send a push notification.
     * - DB record: always awaited (fast)
     * - Push delivery: fire-and-forget (non-blocking)
     */
    async notify(userId: string, payload: NotifyPayload): Promise<void> {
        // 1. Persist notification to DB (always awaited)
        await prisma.notification.create({
            data: {
                userId,
                type: payload.type as any,
                title: payload.title,
                message: payload.message,
                metadata: (payload.metadata ?? {}) as any,
            },
        });

        // 2. Send push notification (fire-and-forget — does NOT block the response)
        this.sendPushAsync(userId, {
            title: payload.title,
            body: payload.message,
            data: { type: payload.type },
        }).catch((err) => {
            console.error(`[NotificationService] Push failed for user ${userId}:`, err);
        });
    }

    /**
     * Internal: look up device tokens and send push via Firebase/Expo.
     * Automatically cleans up invalid tokens.
     */
    private async sendPushAsync(
        userId: string,
        payload: { title: string; body: string; data?: Record<string, string> }
    ): Promise<void> {
        const deviceTokens = await prisma.deviceToken.findMany({
            where: { userId, isActive: true },
            select: { token: true },
        });

        if (deviceTokens.length === 0) return;

        const tokens = deviceTokens.map((t) => t.token);
        const invalidTokens = await firebaseService.sendToMultiple(tokens, payload);

        // Deactivate invalid tokens
        if (invalidTokens.length > 0) {
            await prisma.deviceToken.updateMany({
                where: { token: { in: invalidTokens } },
                data: { isActive: false },
            });
        }
    }
}

export const notificationService = new NotificationService();
