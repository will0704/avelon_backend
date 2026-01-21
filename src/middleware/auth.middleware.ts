import { createMiddleware } from 'hono/factory';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { UnauthorizedError, ForbiddenError } from './error.middleware.js';
import { prisma } from '../lib/prisma.js';
import { UserRole, UserStatus, type TokenPayload } from '@avelon_capstone/types';

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

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new UnauthorizedError('Missing or invalid authorization header');
    }

    const token = authHeader.substring(7);

    try {
        const payload = verify(token, env.JWT_SECRET) as JWTPayload;

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

    if (user.status !== UserStatus.APPROVED) {
        throw new ForbiddenError('KYC approval required to access this feature');
    }

    await next();
});
