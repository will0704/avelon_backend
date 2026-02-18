import { createMiddleware } from 'hono/factory';
import { RateLimitError } from './error.middleware.js';
import { securityLogger } from '../lib/security.logger.js';

// =====================================================
// IN-MEMORY RATE LIMITER (OWASP A04 + A07)
// =====================================================

interface RateLimitEntry {
    count: number;
    resetAt: number;
}

interface RateLimitConfig {
    windowMs: number;       // Time window in milliseconds
    maxRequests: number;    // Max requests per window
    keyPrefix?: string;     // Prefix for identifying the limiter
}

// In-memory store (can be swapped for Redis in production)
const store = new Map<string, RateLimitEntry>();

// Cleanup expired entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
        if (now > entry.resetAt) {
            store.delete(key);
        }
    }
}, 5 * 60 * 1000);

/**
 * Creates a rate limiting middleware
 */
function createRateLimiter(config: RateLimitConfig) {
    const { windowMs, maxRequests, keyPrefix = 'global' } = config;

    return createMiddleware(async (c, next) => {
        const ip = c.req.header('x-forwarded-for')
            || c.req.header('x-real-ip')
            || 'unknown';

        const key = `${keyPrefix}:${ip}`;
        const now = Date.now();

        let entry = store.get(key);

        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs };
            store.set(key, entry);
        }

        entry.count++;

        // Set rate limit headers
        const remaining = Math.max(0, maxRequests - entry.count);
        const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);

        c.header('X-RateLimit-Limit', maxRequests.toString());
        c.header('X-RateLimit-Remaining', remaining.toString());
        c.header('X-RateLimit-Reset', resetSeconds.toString());

        if (entry.count > maxRequests) {
            c.header('Retry-After', resetSeconds.toString());

            securityLogger.log({
                event: 'RATE_LIMIT',
                ip,
                method: c.req.method,
                path: c.req.path,
                details: { keyPrefix, count: entry.count, limit: maxRequests },
            });

            throw new RateLimitError(
                `Too many requests. Please try again in ${resetSeconds} seconds.`
            );
        }

        await next();
    });
}

/**
 * Global rate limiter — 100 requests per 15 minutes per IP
 */
export const globalRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 100,
    keyPrefix: 'global',
});

/**
 * Auth rate limiter — 5 requests per 15 minutes per IP
 * Applied to login, register, forgot-password
 */
export const authRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 5,
    keyPrefix: 'auth',
});

// =====================================================
// BRUTE-FORCE / ACCOUNT LOCKOUT TRACKER (OWASP A07)
// =====================================================

interface LoginAttemptEntry {
    failedCount: number;
    lockedUntil: number | null;
    lastAttemptAt: number;
}

const loginAttempts = new Map<string, LoginAttemptEntry>();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Cleanup expired lockouts every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of loginAttempts) {
        if (entry.lockedUntil && now > entry.lockedUntil) {
            loginAttempts.delete(key);
        }
    }
}, 10 * 60 * 1000);

/**
 * Check if an account is locked out
 */
export function isAccountLocked(email: string): { locked: boolean; retryAfterSeconds?: number } {
    const entry = loginAttempts.get(email.toLowerCase());
    if (!entry || !entry.lockedUntil) return { locked: false };

    const now = Date.now();
    if (now > entry.lockedUntil) {
        loginAttempts.delete(email.toLowerCase());
        return { locked: false };
    }

    return {
        locked: true,
        retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
    };
}

/**
 * Record a failed login attempt. Returns true if account is now locked.
 */
export function recordFailedLogin(email: string, ip?: string): boolean {
    const key = email.toLowerCase();
    const now = Date.now();

    let entry = loginAttempts.get(key);
    if (!entry) {
        entry = { failedCount: 0, lockedUntil: null, lastAttemptAt: now };
        loginAttempts.set(key, entry);
    }

    entry.failedCount++;
    entry.lastAttemptAt = now;

    if (entry.failedCount >= MAX_FAILED_ATTEMPTS) {
        entry.lockedUntil = now + LOCKOUT_DURATION_MS;

        securityLogger.log({
            event: 'ACCOUNT_LOCKOUT',
            ip: ip || 'unknown',
            details: {
                email: key,
                failedAttempts: entry.failedCount,
                lockedForMinutes: LOCKOUT_DURATION_MS / 60000,
            },
        });

        return true;
    }

    return false;
}

/**
 * Reset failed login attempts on successful login
 */
export function resetLoginAttempts(email: string): void {
    loginAttempts.delete(email.toLowerCase());
}
