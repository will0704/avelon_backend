import { createMiddleware } from 'hono/factory';
import { randomBytes } from 'crypto';

// =====================================================
// SECURITY MIDDLEWARE (OWASP A04, A05, A08)
// =====================================================

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB

/**
 * Request body size limiter
 * Prevents DoS attacks via oversized payloads
 */
export const bodySizeLimiter = createMiddleware(async (c, next) => {
    const contentLength = c.req.header('content-length');

    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
        return c.json({
            success: false,
            error: {
                code: 'PAYLOAD_TOO_LARGE',
                message: 'Request body exceeds the maximum allowed size of 1MB',
            },
        }, 413);
    }

    return await next();
});

/**
 * Request ID middleware
 * Attaches a unique ID to every request for tracing and log correlation
 */
export const requestId = createMiddleware(async (c, next) => {
    const id = c.req.header('x-request-id') || randomBytes(16).toString('hex');
    c.header('X-Request-Id', id);
    c.set('requestId' as never, id);
    return await next();
});

/**
 * Content-Type enforcement middleware
 * Ensures POST/PUT/PATCH requests include proper Content-Type header
 * Prevents content-type confusion attacks (OWASP A08)
 */
export const enforceContentType = createMiddleware(async (c, next) => {
    const method = c.req.method;

    if (['POST', 'PUT', 'PATCH'].includes(method)) {
        const contentType = c.req.header('content-type');

        // Allow requests without body (content-length: 0)
        const contentLength = c.req.header('content-length');
        if (contentLength === '0') {
            return await next();
        }

        if (contentType && !contentType.includes('application/json') && !contentType.includes('multipart/form-data')) {
            return c.json({
                success: false,
                error: {
                    code: 'UNSUPPORTED_MEDIA_TYPE',
                    message: 'Content-Type must be application/json or multipart/form-data',
                },
            }, 415);
        }
    }

    return await next();
});
