import { createMiddleware } from 'hono/factory';
import jwt from 'jsonwebtoken';
import { corsAllowedOrigins, env } from '../config/env.js';
import { UnauthorizedError, ForbiddenError } from './error.middleware.js';
import { prisma } from '../lib/prisma.js';
import { UserRole, UserStatus, type TokenPayload } from '../types/index.js';
import { getCookie } from 'hono/cookie';

const { verify } = jwt;

// Types for context variables
export interface AuthUser {
    id: string;
    email: string;
    role: UserRole;
    status: UserStatus;
}

declare module 'hono' {
    interface ContextVariableMap {
        userId: string;
        user: AuthUser;
    }
}

/**
 * JWT payload structure - using shared TokenPayload
 */
type JWTPayload = TokenPayload;

/**
 * Authentication middleware
 * Validates JWT token and attaches user to context
 */
export const authMiddleware = createMiddleware(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
    const cookieToken = getCookie(c, 'accessToken');
    const token = bearerToken ?? cookieToken;
    if (!token) throw new UnauthorizedError('Missing authentication token');

    // HttpOnly-cookie sessions need an origin check on state-changing requests
    // because production cookies use SameSite=None for the separate web/API hosts.
    if (!bearerToken && cookieToken && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
        const origin = c.req.header('Origin');
        if (!origin || !corsAllowedOrigins.includes(origin)) {
            throw new ForbiddenError('Untrusted request origin');
        }
    }

    try {
        const payload = verify(token, env.JWT_SECRET) as JWTPayload;

        if (payload.type !== 'access' || !payload.jti) {
            throw new UnauthorizedError('Invalid access token');
        }

        const session = await prisma.session.findFirst({
            where: {
                userId: payload.userId,
                sessionToken: payload.jti,
                expires: { gt: new Date() },
            },
            select: { id: true },
        });
        if (!session) {
            throw new UnauthorizedError('Session expired or revoked');
        }

        // Fetch user from database
        const user = await prisma.user.findUnique({
            where: { id: payload.userId },
            select: {
                id: true,
                email: true,
                role: true,
                status: true,
            },
        });

        if (!user) {
            throw new UnauthorizedError('User not found');
        }

        if (user.status === UserStatus.SUSPENDED) {
            throw new ForbiddenError('Account suspended');
        }

        // Attach user info to context
        c.set('userId', user.id);
        c.set('user', user as AuthUser);

        await next();
    } catch (error) {
        if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
            throw error;
        }
        throw new UnauthorizedError('Invalid or expired token');
    }
});

/**
 * Admin-only middleware
 * Must be used after authMiddleware
 */
export const adminMiddleware = createMiddleware(async (c, next) => {
    const user = c.get('user');

    if (!user) {
        throw new UnauthorizedError('Authentication required');
    }

    if (user.role !== UserRole.ADMIN) {
        throw new ForbiddenError('Admin access required');
    }

    await next();
});

/**
 * Verified user middleware
 * Ensures user has at least verified email
 */
export const verifiedMiddleware = createMiddleware(async (c, next) => {
    const user = c.get('user');

    if (!user) {
        throw new UnauthorizedError('Authentication required');
    }

    if (user.status === UserStatus.REGISTERED) {
        throw new ForbiddenError('Please verify your email first');
    }

    await next();
});

/**
 * Approved user middleware
 * Ensures user has completed KYC and is approved
 */
export const approvedMiddleware = createMiddleware(async (c, next) => {
    const user = c.get('user');

    if (!user) {
        throw new UnauthorizedError('Authentication required');
    }

    if (user.status !== UserStatus.APPROVED && user.status !== UserStatus.CONNECTED) {
        throw new ForbiddenError('KYC approval required to access this feature');
    }

    await next();
});

/**
 * Investor-only middleware
 * Must be used after authMiddleware
 */
export const investorMiddleware = createMiddleware(async (c, next) => {
    const user = c.get('user');

    if (!user) {
        throw new UnauthorizedError('Authentication required');
    }

    if (user.role !== UserRole.INVESTOR) {
        throw new ForbiddenError('Investor access required');
    }

    await next();
});
