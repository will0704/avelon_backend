import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError, ZodIssue } from 'zod';
import { env } from '../config/env.js';
import { ErrorCode } from '@avelon_capstone/types';

// Custom error classes
export class AppError extends Error {
    constructor(
        public statusCode: number,
        public code: ErrorCode | string,
        message: string,
        public details?: unknown
    ) {
        super(message);
        this.name = 'AppError';
    }
}

export class ValidationError extends AppError {
    constructor(message: string, details?: unknown) {
        super(400, ErrorCode.VALIDATION_ERROR, message, details);
        this.name = 'ValidationError';
    }
}

export class UnauthorizedError extends AppError {
    constructor(message: string = 'Unauthorized') {
        super(401, ErrorCode.UNAUTHORIZED, message);
        this.name = 'UnauthorizedError';
    }
}

export class ForbiddenError extends AppError {
    constructor(message: string = 'Forbidden') {
        super(403, ErrorCode.FORBIDDEN, message);
        this.name = 'ForbiddenError';
    }
}

export class NotFoundError extends AppError {
    constructor(message: string = 'Resource not found') {
        super(404, ErrorCode.NOT_FOUND, message);
        this.name = 'NotFoundError';
    }
}

export class ConflictError extends AppError {
    constructor(message: string = 'Resource already exists') {
        super(409, ErrorCode.ALREADY_EXISTS, message);
        this.name = 'ConflictError';
    }
}

export class RateLimitError extends AppError {
    constructor(message: string = 'Too many requests') {
        super(429, ErrorCode.RATE_LIMITED, message);
        this.name = 'RateLimitError';
    }
}

export class BlockchainError extends AppError {
    constructor(message: string = 'Blockchain interaction failed') {
        super(502, ErrorCode.BLOCKCHAIN_ERROR, message);
        this.name = 'BlockchainError';
    }
}

export class AIServiceError extends AppError {
    constructor(message: string = 'AI service unavailable') {
        super(502, ErrorCode.AI_SERVICE_ERROR, message);
        this.name = 'AIServiceError';
    }
}

// Error handler middleware
export const errorHandler = (err: Error, c: Context) => {
    console.error('Error:', err);

    // Handle Zod validation errors
    if (err instanceof ZodError) {
        return c.json({
            success: false,
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Invalid input data',
                details: err.issues.map((e: ZodIssue) => ({
                    field: e.path.join('.'),
                    message: e.message,
                })),
            },
        }, 400);
    }

    // Handle our custom errors
    if (err instanceof AppError) {
        return c.json({
            success: false,
            error: {
                code: err.code,
                message: err.message,
                ...(err.details ? { details: err.details } : {}),
            },
        }, err.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502);
    }

    // Handle Hono HTTP exceptions
    if (err instanceof HTTPException) {
        return c.json({
            success: false,
            error: {
                code: 'HTTP_ERROR',
                message: err.message,
            },
        }, err.status);
    }

    // Handle unknown errors
    const isDev = env.NODE_ENV === 'development';
    return c.json({
        success: false,
        error: {
            code: 'INTERNAL_ERROR',
            message: isDev ? err.message : 'An unexpected error occurred',
            ...(isDev ? { stack: err.stack } : {}),
        },
    }, 500);
};
