import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { authService } from '../services/auth.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import type { TokenPayload } from '@avelon_capstone/types';

const { verify } = jwt;

const authRoutes = new Hono();

// Validation schemas
const registerSchema = z.object({
    email: z.string().email('Invalid email format'),
    password: z
        .string()
        .min(8, 'Password must be at least 8 characters')
        .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
        .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
        .regex(/[0-9]/, 'Password must contain at least one number')
        .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
    name: z.string().min(2).optional(),
});

const loginSchema = z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(1, 'Password is required'),
});

const verifyEmailSchema = z.object({
    token: z.string().min(1, 'Token is required'),
});

const forgotPasswordSchema = z.object({
    email: z.string().email('Invalid email format'),
});

const resetPasswordSchema = z.object({
    token: z.string().min(1, 'Token is required'),
    password: z
        .string()
        .min(8, 'Password must be at least 8 characters')
        .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
        .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
        .regex(/[0-9]/, 'Password must contain at least one number')
        .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
});

const refreshTokenSchema = z.object({
    refreshToken: z.string().min(1, 'Refresh token is required'),
});

// =====================================================
// ROUTES
// =====================================================

/**
 * POST /auth/register
 * Register a new user
 */
authRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
    const body = c.req.valid('json');

    const result = await authService.register(body);

    // TODO: Send verification email here

    // TODO: Send verification email with result.verificationToken
    // SECURITY: Never expose tokens in API responses (OWASP A02)

    return c.json({
        success: true,
        message: 'Registration successful. Please check your email to verify your account.',
        data: {
            email: result.user.email,
        },
    }, 201);
});

/**
 * POST /auth/login
 * Login with email and password
 */
authRoutes.post('/login', zValidator('json', loginSchema), async (c) => {
    const body = c.req.valid('json');
    const ipAddress = c.req.header('x-forwarded-for') || c.req.header('x-real-ip');
    const userAgent = c.req.header('user-agent');

    const result = await authService.login(body, ipAddress, userAgent);

    return c.json({
        success: true,
        data: result,
    });
});

/**
 * POST /auth/logout
 * End current session
 */
authRoutes.post('/logout', authMiddleware, async (c) => {
    const userId = c.get('userId');

    await authService.logout(userId);

    return c.json({
        success: true,
        message: 'Logged out successfully',
    });
});

/**
 * POST /auth/verify-email
 * Verify email with token
 */
authRoutes.post('/verify-email', zValidator('json', verifyEmailSchema), async (c) => {
    const { token } = c.req.valid('json');

    await authService.verifyEmail(token);

    return c.json({
        success: true,
        message: 'Email verified successfully',
    });
});

/**
 * POST /auth/forgot-password
 * Request password reset email
 */
authRoutes.post('/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
    const { email } = c.req.valid('json');

    const result = await authService.forgotPassword(email);

    // TODO: Send email with reset link using result.token
    // SECURITY: Never expose tokens in API responses (OWASP A02)

    return c.json({
        success: true,
        message: 'If an account exists with this email, you will receive a password reset link.',
    });
});

/**
 * POST /auth/reset-password
 * Reset password with token
 */
authRoutes.post('/reset-password', zValidator('json', resetPasswordSchema), async (c) => {
    const { token, password } = c.req.valid('json');

    await authService.resetPassword(token, password);

    return c.json({
        success: true,
        message: 'Password reset successfully',
    });
});

/**
 * GET /auth/session
 * Get current session
 */
authRoutes.get('/session', async (c) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({
            success: true,
            data: {
                user: null,
                isAuthenticated: false,
            },
        });
    }

    // Try to validate token
    try {
        // Reuse auth middleware logic but don't throw
        const token = authHeader.substring(7);

        const payload = verify(token, env.JWT_SECRET) as TokenPayload;

        const user = await prisma.user.findUnique({
            where: { id: payload.userId },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                status: true,
                kycLevel: true,
                creditScore: true,
                creditTier: true,
            },
        });

        if (!user) {
            return c.json({
                success: true,
                data: {
                    user: null,
                    isAuthenticated: false,
                },
            });
        }

        return c.json({
            success: true,
            data: {
                user,
                isAuthenticated: true,
            },
        });
    } catch {
        return c.json({
            success: true,
            data: {
                user: null,
                isAuthenticated: false,
            },
        });
    }
});

/**
 * POST /auth/refresh
 * Refresh access token
 */
authRoutes.post('/refresh', zValidator('json', refreshTokenSchema), async (c) => {
    const { refreshToken } = c.req.valid('json');

    const result = await authService.refreshToken(refreshToken);

    return c.json({
        success: true,
        data: result,
    });
});

export { authRoutes };
