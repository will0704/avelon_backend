import admin from 'firebase-admin';
import { env } from '../config/env.js';

interface PushPayload {
    title: string;
    body: string;
    data?: Record<string, string>;
}

class FirebaseService {
    private isConfigured = false;

    constructor() {
        if (
            env.FIREBASE_PROJECT_ID &&
            env.FIREBASE_PRIVATE_KEY &&
            env.FIREBASE_CLIENT_EMAIL
        ) {
            // Avoid re-initializing if already initialized (e.g. hot-reload)
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
     * Send a push notification to a single device token
     */
    async sendToDevice(token: string, payload: PushPayload): Promise<boolean> {
        if (!this.isConfigured) {
            console.log(`[STUB] Push to ${token}: ${payload.title}`);
            return true;
        }

        try {
            await admin.messaging().send({
                token,
                notification: {
                    title: payload.title,
                    body: payload.body,
                },
                data: payload.data,
                android: {
                    priority: 'high',
                    notification: {
                        sound: 'default',
                    },
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                        },
                    },
                },
            });
            return true;
        } catch (error: any) {
            // Token is invalid/expired — signal caller to deactivate it
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
        if (!this.isConfigured || tokens.length === 0) return [];

        const invalidTokens: string[] = [];

        // FCM sendEachForMulticast — up to 500 tokens per call
        const chunks = chunkArray(tokens, 500);

        for (const chunk of chunks) {
            const response = await admin.messaging().sendEachForMulticast({
                tokens: chunk,
                notification: {
                    title: payload.title,
                    body: payload.body,
                },
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
