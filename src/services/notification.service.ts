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
     * Store a notification and push it. Runs after the action it reports has
     * already happened, so a failure here is logged, never thrown.
     */
    async notify(userId: string, payload: NotifyPayload): Promise<void> {
        try {
            await prisma.notification.create({
                data: {
                    userId,
                    type: payload.type as any,
                    title: payload.title,
                    message: payload.message,
                    metadata: (payload.metadata ?? {}) as any,
                },
            });
        } catch (err) {
            console.error(`[NotificationService] Could not store ${payload.type} for user ${userId}:`, err);
            return;
        }

        const loanId = payload.metadata?.loanId;
        this.sendPushAsync(userId, {
            title: payload.title,
            body: payload.message,
            data: { type: payload.type, ...(typeof loanId === 'string' ? { loanId } : {}) },
        }).catch((err) => {
            console.error(`[NotificationService] Push failed for user ${userId}:`, err);
        });
    }

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
