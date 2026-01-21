import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { ConflictError, UnauthorizedError, ValidationError } from '../middleware/error.middleware.js';
import { UserRole, UserStatus, type RegisterData, type LoginCredentials, type AuthTokens } from '@avelon_capstone/types';

const { sign, verify } = jwt;
const { hash, compare } = bcrypt;

const SALT_ROUNDS = 12;

// Re-export types for backward compatibility
export type RegisterInput = RegisterData;
export type LoginInput = LoginCredentials;
export type TokenPair = Omit<AuthTokens, 'expiresIn'>;

export class AuthService {
    /**
     * Register a new user
     */
    async register(input: RegisterInput) {
        const { email, password, name } = input;

        // Check if user already exists
        const existing = await prisma.user.findUnique({
            where: { email: email.toLowerCase() },
        });

        if (existing) {
            throw new ConflictError('An account with this email already exists');
        }

        // Hash password
        const passwordHash = await hash(password, SALT_ROUNDS);

        // Create user
        const user = await prisma.user.create({
            data: {
                email: email.toLowerCase(),
                passwordHash,
                name,
                role: UserRole.BORROWER,
                status: UserStatus.REGISTERED,
            },
        });

        // Create verification token
        const token = randomBytes(32).toString('hex');
        await prisma.verificationToken.create({
            data: {
                identifier: user.email,
                token,
                type: 'EMAIL_VERIFICATION',
                expires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
            },
        });

        // Log audit
        await prisma.auditLog.create({
            data: {
                userId: user.id,
                action: 'REGISTER',
                entity: 'User',
                entityId: user.id,
            },
        });

        return {
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                status: user.status,
            },
            verificationToken: token,
        };
    }

    /**
     * Login with email and password
     */
    async login(input: LoginInput, ipAddress?: string, userAgent?: string) {
        const { email, password } = input;

        // Find user
        const user = await prisma.user.findUnique({
            where: { email: email.toLowerCase() },
        });

        if (!user || !user.passwordHash) {
            throw new UnauthorizedError('Invalid email or password');
        }

        // Check password
        const isValid = await compare(password, user.passwordHash);
        if (!isValid) {
            throw new UnauthorizedError('Invalid email or password');
        }

        // Check if suspended
        if (user.status === UserStatus.SUSPENDED) {
            throw new UnauthorizedError('Account suspended. Please contact support.');
        }

        // Generate tokens
        const tokens = this.generateTokens(user.id, user.email, user.role);

        // Create session with unique token
        const sessionToken = randomBytes(32).toString('hex');
        await prisma.session.create({
            data: {
                userId: user.id,
                sessionToken,
                expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
                ipAddress,
                userAgent,
            },
        });

        // Update last login
        await prisma.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
        });

        // Log audit
        await prisma.auditLog.create({
            data: {
                userId: user.id,
                action: 'LOGIN',
                entity: 'User',
                entityId: user.id,
                ipAddress,
                userAgent,
            },
        });

        return {
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                status: user.status,
                kycLevel: user.kycLevel,
                creditScore: user.creditScore,
                creditTier: user.creditTier,
            },
            ...tokens,
        };
    }

    /**
     * Verify email with token
     */
    async verifyEmail(token: string) {
        const verificationToken = await prisma.verificationToken.findFirst({
            where: {
                token,
                type: 'EMAIL_VERIFICATION',
                expires: { gt: new Date() },
            },
        });

        if (!verificationToken) {
            throw new ValidationError('Invalid or expired verification token');
        }

        // Update user status
        const user = await prisma.user.update({
            where: { email: verificationToken.identifier },
            data: {
                emailVerified: new Date(),
                status: UserStatus.VERIFIED,
            },
        });

        // Delete the token
        await prisma.verificationToken.delete({
            where: { token },
        });

        // Log audit
        await prisma.auditLog.create({
            data: {
                userId: user.id,
                action: 'EMAIL_VERIFIED',
                entity: 'User',
                entityId: user.id,
            },
        });

        return { success: true };
    }

    /**
     * Request password reset
     */
    async forgotPassword(email: string) {
        const user = await prisma.user.findUnique({
            where: { email: email.toLowerCase() },
        });

        // Always return success to prevent email enumeration
        if (!user) {
            return { success: true };
        }

        // Delete any existing reset tokens
        await prisma.verificationToken.deleteMany({
            where: {
                identifier: email,
                type: 'PASSWORD_RESET',
            },
        });

        // Create new reset token
        const token = randomBytes(32).toString('hex');
        await prisma.verificationToken.create({
            data: {
                identifier: email,
                token,
                type: 'PASSWORD_RESET',
                expires: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
            },
        });

        // TODO: Send email with reset link

        return { success: true, token }; // Token returned for dev, remove in prod
    }

    /**
     * Reset password with token
     */
    async resetPassword(token: string, newPassword: string) {
        const resetToken = await prisma.verificationToken.findFirst({
            where: {
                token,
                type: 'PASSWORD_RESET',
                expires: { gt: new Date() },
            },
        });

        if (!resetToken) {
            throw new ValidationError('Invalid or expired reset token');
        }

        // Hash new password
        const passwordHash = await hash(newPassword, SALT_ROUNDS);

        // Update user password
        const user = await prisma.user.update({
            where: { email: resetToken.identifier },
            data: { passwordHash },
        });

        // Delete the token
        await prisma.verificationToken.delete({
            where: { token },
        });

        // Invalidate all sessions
        await prisma.session.deleteMany({
            where: { userId: user.id },
        });

        // Log audit
        await prisma.auditLog.create({
            data: {
                userId: user.id,
                action: 'PASSWORD_RESET',
                entity: 'User',
                entityId: user.id,
            },
        });

        return { success: true };
    }

    /**
     * Refresh access token
     */
    async refreshToken(refreshToken: string) {
        try {
            const payload = verify(refreshToken, env.JWT_SECRET) as {
                sub: string;
                email: string;
                role: string;
                type: string;
            };

            if (payload.type !== 'refresh') {
                throw new UnauthorizedError('Invalid refresh token');
            }

            // Check if session exists
            const session = await prisma.session.findFirst({
                where: {
                    userId: payload.sub,
                    sessionToken: refreshToken.substring(0, 64),
                    expires: { gt: new Date() },
                },
            });

            if (!session) {
                throw new UnauthorizedError('Session expired');
            }

            // Generate new access token
            const accessToken = this.generateAccessToken(
                payload.sub,
                payload.email,
                payload.role
            );

            return { accessToken };
        } catch (error) {
            throw new UnauthorizedError('Invalid refresh token');
        }
    }

    /**
     * Logout - invalidate all sessions for user
     */
    async logout(userId: string) {
        // Delete all sessions for this user
        await prisma.session.deleteMany({
            where: { userId },
        });

        // Log audit
        await prisma.auditLog.create({
            data: {
                userId,
                action: 'LOGOUT',
                entity: 'User',
                entityId: userId,
            },
        });

        return { success: true };
    }

    /**
     * Generate JWT tokens
     */
    private generateTokens(userId: string, email: string, role: string): TokenPair {
        const accessToken = this.generateAccessToken(userId, email, role);
        const refreshToken = this.generateRefreshToken(userId, email, role);

        return { accessToken, refreshToken };
    }

    /**
     * Parse duration string to seconds
     * Supports: s (seconds), m (minutes), h (hours), d (days)
     */
    private parseDuration(duration: string): number {
        const match = duration.match(/^(\d+)([smhd])$/);
        if (!match) {
            // Default to 15 minutes if invalid format
            return 15 * 60;
        }
        const value = parseInt(match[1], 10);
        const unit = match[2];
        switch (unit) {
            case 's': return value;
            case 'm': return value * 60;
            case 'h': return value * 60 * 60;
            case 'd': return value * 60 * 60 * 24;
            default: return 15 * 60;
        }
    }

    private generateAccessToken(userId: string, email: string, role: string): string {
        const expiresIn = this.parseDuration(env.JWT_ACCESS_EXPIRY);
        return sign(
            { userId, email, role, type: 'access' },
            env.JWT_SECRET,
            { expiresIn }
        );
    }

    private generateRefreshToken(userId: string, email: string, role: string): string {
        const expiresIn = this.parseDuration(env.JWT_REFRESH_EXPIRY);
        return sign(
            { userId, email, role, type: 'refresh' },
            env.JWT_SECRET,
            { expiresIn }
        );
    }
}

export const authService = new AuthService();
