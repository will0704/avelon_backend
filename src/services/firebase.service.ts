import admin from 'firebase-admin';
import { env } from '../config/env.js';

interface PushPayload {
    title: string;
    body: string;
    data?: Record<string, string>;
}

// ─── Expo Push API helper ────────────────────────────────────────────────────
// Handles ExponentPushToken[xxx] tokens — works with Expo Go and dev builds

async function sendViaExpo(tokens: string[], payload: PushPayload): Promise<string[]> {
    const messages = tokens.map((to) => ({
        to,
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
        sound: 'default',
        priority: 'high',
    }));

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
    });

    const json = await res.json() as { data: { status: string; id?: string; details?: { error?: string } }[] };
    const invalidTokens: string[] = [];

    json.data?.forEach((result, idx) => {
        if (result.status === 'error') {
            const err = result.details?.error;
            if (err === 'DeviceNotRegistered' || err === 'InvalidCredentials') {
                invalidTokens.push(tokens[idx]);
            }
            console.error(`[Expo Push] Error for token ${tokens[idx]}:`, err);
        }
    });

    return invalidTokens;
}


class FirebaseService {
    private isConfigured = false;

    constructor() {
        if (
            env.FIREBASE_PROJECT_ID &&
            env.FIREBASE_PRIVATE_KEY &&
            env.FIREBASE_CLIENT_EMAIL
        ) {
            if (!admin.apps.length) {
                admin.initializeApp({
                    credential: admin.credential.cert({
                        projectId: env.FIREBASE_PROJECT_ID,
                        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                        clientEmail: env.FIREBASE_CLIENT_EMAIL,
                    }),
                });
            }
            this.isConfigured = true;
            console.log('✅ Firebase Admin (FCM) initialized');
        } else {
            console.warn('⚠️ Firebase credentials not found. Push notifications are disabled.');
        }
    }

    /**
     * Send a push notification to a single device token.
     * Automatically routes Expo tokens to Expo's push API.
     */
    async sendToDevice(token: string, payload: PushPayload): Promise<boolean> {
        // Route Expo Go / Expo dev-client tokens through Expo's push service
        if (token.startsWith('ExponentPushToken[')) {
            const invalid = await sendViaExpo([token], payload);
            return invalid.length === 0;
        }

        if (!this.isConfigured) {
            console.log(`[STUB] Push to ${token}: ${payload.title}`);
            return true;
        }

        try {
            await admin.messaging().send({
                token,
                notification: { title: payload.title, body: payload.body },
                data: payload.data,
                android: { priority: 'high', notification: { sound: 'default' } },
                apns: { payload: { aps: { sound: 'default' } } },
            });
            return true;
        } catch (error: any) {
            if (
                error?.code === 'messaging/registration-token-not-registered' ||
                error?.code === 'messaging/invalid-registration-token'
            ) {
                return false;
            }
            console.error('FCM send error:', error);
            return false;
        }
    }

    /**
     * Send a push notification to multiple device tokens.
     * Returns the tokens that are invalid and should be deactivated.
     */
    async sendToMultiple(tokens: string[], payload: PushPayload): Promise<string[]> {
        if (tokens.length === 0) return [];

        // Split into Expo tokens and raw FCM tokens
        const expoTokens = tokens.filter((t) => t.startsWith('ExponentPushToken['));
        const fcmTokens = tokens.filter((t) => !t.startsWith('ExponentPushToken['));

        const invalidTokens: string[] = [];

        // Send Expo tokens via Expo push API
        if (expoTokens.length > 0) {
            const expoChunks = chunkArray(expoTokens, 100);
            for (const chunk of expoChunks) {
                const invalid = await sendViaExpo(chunk, payload);
                invalidTokens.push(...invalid);
            }
        }

        // Send FCM tokens via Firebase
        if (fcmTokens.length > 0 && this.isConfigured) {
            const fcmChunks = chunkArray(fcmTokens, 500);
            for (const chunk of fcmChunks) {
                const response = await admin.messaging().sendEachForMulticast({
                    tokens: chunk,
                    notification: { title: payload.title, body: payload.body },
                    data: payload.data,
                    android: { priority: 'high', notification: { sound: 'default' } },
                    apns: { payload: { aps: { sound: 'default' } } },
                });
                response.responses.forEach((res, idx) => {
                    if (!res.success) {
                        const code = (res.error as any)?.code ?? '';
                        if (
                            code === 'messaging/registration-token-not-registered' ||
                            code === 'messaging/invalid-registration-token'
                        ) {
                            invalidTokens.push(chunk[idx]);
                        }
                    }
                });
            }
        }

        return invalidTokens;
    }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

export const firebaseService = new FirebaseService();

