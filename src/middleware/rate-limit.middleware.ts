import { createMiddleware } from 'hono/factory';
import { RateLimitError } from './error.middleware.js';
import { securityLogger } from '../lib/security.logger.js';
import { Redis } from 'ioredis';

// =====================================================
// REDIS-BACKED RATE LIMITER  (OWASP A04 + A07)
// Falls back to in-memory Map when Redis is unavailable.
// =====================================================

// Redis singleton — null when REDIS_URL is not configured
let redis: Redis | null = null;

if (process.env.REDIS_URL) {
    try {
        redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, enableOfflineQueue: false });
        redis.on('error', (err: Error) => {
            console.warn('[rate-limit] Redis error (falling back to in-memory):', err.message);
        });
        console.log('✅ Rate limiter using Redis');
    } catch {
        console.warn('⚠️ Failed to initialise Redis. Using in-memory rate limiting.');
        redis = null;
    }
} else {
    console.warn('⚠️ REDIS_URL not set. Rate limiting is in-memory (single-process only).');
}

// ─── In-memory fallback store ────────────────────────

interface RateLimitEntry {
    count: number;
    resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup expired entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
        if (now > entry.resetAt) store.delete(key);
    }
}, 5 * 60 * 1000);

// ─── Unified counter ─────────────────────────────────

/**
 * Increment a rate-limit counter. Returns the new count.
 * Uses Redis INCR+EXPIRE when available; falls back to the in-memory Map.
 */
async function incrementCounter(key: string, windowMs: number): Promise<number> {
    const windowSecs = Math.ceil(windowMs / 1000);

    if (redis) {
        try {
            const count = await redis.incr(key);
            if (count === 1) {
                await redis.expire(key, windowSecs);
            }
            return count;
        } catch {
            // Redis unavailable — fall through to in-memory
        }
    }

    const now = Date.now();
    let entry = store.get(key);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        store.set(key, entry);
    }
    entry.count++;
    return entry.count;
}

/**
 * Get the remaining TTL (seconds) for a key.
 */
async function getTTL(key: string, windowMs: number): Promise<number> {
    if (redis) {
        try {
            const ttl = await redis.ttl(key);
            if (ttl > 0) return ttl;
        } catch { /* ignore */ }
    }

    const entry = store.get(key);
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.resetAt - Date.now()) / 1000));
}

// ─── Rate-limiter factory ────────────────────────────

interface RateLimitConfig {
    windowMs: number;
    maxRequests: number;
    keyPrefix?: string;
}

export function createRateLimiter(config: RateLimitConfig) {
    const { windowMs, maxRequests, keyPrefix = 'global' } = config;

    return createMiddleware(async (c, next) => {
        const ip = c.req.header('x-forwarded-for')
            || c.req.header('x-real-ip')
            || 'unknown';

        const key = `rl:${keyPrefix}:${ip}`;
        const count = await incrementCounter(key, windowMs);
        const resetSeconds = await getTTL(key, windowMs);
        const remaining = Math.max(0, maxRequests - count);

        c.header('X-RateLimit-Limit', maxRequests.toString());
        c.header('X-RateLimit-Remaining', remaining.toString());
        c.header('X-RateLimit-Reset', resetSeconds.toString());

        if (count > maxRequests) {
            c.header('Retry-After', resetSeconds.toString());

            securityLogger.log({
                event: 'RATE_LIMIT',
                ip,
                method: c.req.method,
                path: c.req.path,
                details: { keyPrefix, count, limit: maxRequests },
            });

            throw new RateLimitError(
                `Too many requests. Please try again in ${resetSeconds} seconds.`
            );
        }

        await next();
    });
}

// ─── Named limiters ──────────────────────────────────

/** Global — 100 requests per 15 minutes per IP */
export const globalRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 100,
    keyPrefix: 'global',
});

/** Admin — 500 requests per 15 minutes per IP */
export const adminRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 500,
    keyPrefix: 'admin',
});

/** Auth — 5 requests per 15 minutes per IP (login / register / forgot-password) */
export const authRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 5,
    keyPrefix: 'auth',
});

// =====================================================
// BRUTE-FORCE / ACCOUNT LOCKOUT TRACKER  (OWASP A07)
// =====================================================

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_SECS = Math.ceil(LOCKOUT_DURATION_MS / 1000);

// ─── In-memory fallback ───────────────────────────────

interface LoginAttemptEntry {
    failedCount: number;
    lockedUntil: number | null;
    lastAttemptAt: number;
}

const loginAttempts = new Map<string, LoginAttemptEntry>();

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of loginAttempts) {
        if (entry.lockedUntil && now > entry.lockedUntil) loginAttempts.delete(key);
    }
}, 10 * 60 * 1000);

// ─── Lockout helpers ─────────────────────────────────

/**
 * Check if an account is currently locked out.
 */
export async function isAccountLocked(
    email: string
): Promise<{ locked: boolean; retryAfterSeconds?: number }> {
    const normEmail = email.toLowerCase();
    const lockKey = `rl:locked:${normEmail}`;

    if (redis) {
        try {
            const ttl = await redis.ttl(lockKey);
            if (ttl > 0) return { locked: true, retryAfterSeconds: ttl };
        } catch { /* fall through */ }
    }

    const entry = loginAttempts.get(normEmail);
    if (!entry?.lockedUntil) return { locked: false };
    const now = Date.now();
    if (now > entry.lockedUntil) {
        loginAttempts.delete(normEmail);
        return { locked: false };
    }
    return { locked: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
}

/**
 * Record a failed login attempt.
 * Returns true if the account is now locked.
 */
export async function recordFailedLogin(email: string, ip?: string): Promise<boolean> {
    const normEmail = email.toLowerCase();
    const attemptsKey = `rl:attempts:${normEmail}`;
    const lockKey = `rl:locked:${normEmail}`;

    if (redis) {
        try {
            const attempts = await redis.incr(attemptsKey);
            if (attempts === 1) {
                await redis.expire(attemptsKey, LOCKOUT_SECS);
            }
            if (attempts >= MAX_FAILED_ATTEMPTS) {
                await redis.set(lockKey, '1', 'EX', LOCKOUT_SECS);
                securityLogger.log({
                    event: 'ACCOUNT_LOCKOUT',
                    ip: ip || 'unknown',
                    details: {
                        email: normEmail,
                        failedAttempts: attempts,
                        lockedForMinutes: LOCKOUT_DURATION_MS / 60000,
                    },
                });
                return true;
            }
            return false;
        } catch { /* fall through */ }
    }

    const now = Date.now();
    let entry = loginAttempts.get(normEmail);
    if (!entry) {
        entry = { failedCount: 0, lockedUntil: null, lastAttemptAt: now };
        loginAttempts.set(normEmail, entry);
    }
    entry.failedCount++;
    entry.lastAttemptAt = now;

    if (entry.failedCount >= MAX_FAILED_ATTEMPTS) {
        entry.lockedUntil = now + LOCKOUT_DURATION_MS;
        securityLogger.log({
            event: 'ACCOUNT_LOCKOUT',
            ip: ip || 'unknown',
            details: {
                email: normEmail,
                failedAttempts: entry.failedCount,
                lockedForMinutes: LOCKOUT_DURATION_MS / 60000,
            },
        });
        return true;
    }
    return false;
}

/**
 * Reset failed login attempts after a successful login.
 */
export async function resetLoginAttempts(email: string): Promise<void> {
    const normEmail = email.toLowerCase();

    if (redis) {
        try {
            await redis.del(`rl:attempts:${normEmail}`, `rl:locked:${normEmail}`);
        } catch { /* fall through */ }
    }

    loginAttempts.delete(normEmail);
}
