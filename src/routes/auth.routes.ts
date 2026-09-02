import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { authService } from '../services/auth.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { AppError } from '../middleware/error.middleware.js';
import { env, exposeDemoOtp } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { emailService } from '../services/email.service.js';
import type { TokenPayload } from '../types/index.js';
import { UserRole } from '../types/index.js';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

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
    role: z.enum([UserRole.BORROWER, UserRole.INVESTOR]).optional().default(UserRole.BORROWER),
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

const validateResetTokenSchema = z.object({
    token: z.string().regex(/^\d{6}$/, 'Reset code must contain exactly 6 digits'),
});

const refreshTokenSchema = z.object({
    refreshToken: z.string().min(1, 'Refresh token is required').optional(),
});

function authCookieOptions(maxAge: number) {
    const secure = env.NODE_ENV === 'production';
    return {
        path: '/',
        maxAge,
        httpOnly: true,
        secure,
        sameSite: secure ? 'None' as const : 'Lax' as const,
    };
}

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

    // Send verification email using the OTP generated in the service
    const emailSent = await emailService.sendVerificationEmail(result.user.email, result.verificationToken);
    if (!emailSent) {
        console.warn(`[Auth] Verification email delivery failed for ${result.user.email}. User can request resend.`);
    }

    return c.json({
        success: true,
        message: emailSent
            ? 'Registration successful. Please check your email to verify your account.'
            : 'Registration successful. We could not send the verification email — please use the resend option.',
        data: {
            email: result.user.email,
            emailSent,
            // Development-only escape hatch for demos with no mailbox attached.
            ...(exposeDemoOtp ? { demoVerificationCode: result.verificationToken } : {}),
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

    // Browser clients use HttpOnly cookies; native clients continue to use the
    // response-body tokens with Authorization headers.
    setCookie(c, 'accessToken', result.accessToken, authCookieOptions(15 * 60));
    setCookie(c, 'refreshToken', result.refreshToken, authCookieOptions(7 * 24 * 60 * 60));

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

    deleteCookie(c, 'accessToken', { path: '/' });
    deleteCookie(c, 'refreshToken', { path: '/' });

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

    if (result.token) {
        await emailService.sendPasswordResetEmail(email, result.token);
    }

    return c.json({
        success: true,
        message: 'If an account exists with this email, you will receive a password reset code.',
        // Still says nothing about whether the account exists — result.token is
        // undefined when it does not. Development only.
        ...(exposeDemoOtp && result.token ? { data: { demoResetCode: result.token } } : {}),
    });
});

authRoutes.post('/validate-reset-token', zValidator('json', validateResetTokenSchema), async (c) => {
    const { token } = c.req.valid('json');
    const result = await authService.validatePasswordResetToken(token);
    return c.json({ success: true, data: result });
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
 * POST /auth/change-password
 * Change password for authenticated user
 */
authRoutes.post('/change-password', authMiddleware, zValidator('json', z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
        .string()
        .min(8, 'Password must be at least 8 characters')
        .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
        .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
        .regex(/[0-9]/, 'Password must contain at least one number')
        .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
})), async (c) => {
    const userId = c.get('userId');
    const { currentPassword, newPassword } = c.req.valid('json');

    const result = await authService.changePassword(userId, currentPassword, newPassword);

    return c.json({
        success: true,
        message: result.message,
    });
});

/**
 * GET /auth/session
 * Get current session
 */
authRoutes.get('/session', async (c) => {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ')
        ? authHeader.substring(7)
        : getCookie(c, 'accessToken');

    if (!token) {
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
        const payload = verify(token, env.JWT_SECRET) as TokenPayload;
        if (payload.type !== 'access' || !payload.jti) {
            throw new Error('Invalid access token');
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
            throw new Error('Session expired or revoked');
        }

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
    const refreshToken = c.req.valid('json').refreshToken ?? getCookie(c, 'refreshToken');
    if (!refreshToken) throw new AppError(401, 'UNAUTHORIZED', 'Refresh token is required');

    const result = await authService.refreshToken(refreshToken);
    setCookie(c, 'accessToken', result.accessToken, authCookieOptions(15 * 60));

    return c.json({
        success: true,
        data: result,
    });
});

export { authRoutes };
