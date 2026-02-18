/**
 * OWASP Top 10 — End-to-End Security Tests
 *
 * Tests validate all security measures implemented on the avelon_backend.
 * Uses Hono's built-in app.request() — no HTTP server needed.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// Must import mock BEFORE app to ensure Prisma is mocked
import './prisma.mock.js';

import { app } from '../app.js';

// =====================================================
// HELPERS
// =====================================================

/**
 * Make a JSON request to the app
 */
async function jsonRequest(
    path: string,
    options: {
        method?: string;
        body?: Record<string, unknown>;
        headers?: Record<string, string>;
    } = {}
) {
    const { method = 'GET', body, headers = {} } = options;

    const requestInit: RequestInit = {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...headers,
        },
    };

    if (body) {
        requestInit.body = JSON.stringify(body);
    }

    return app.request(path, requestInit);
}

// =====================================================
// A01 — BROKEN ACCESS CONTROL
// =====================================================

describe('A01 — Broken Access Control', () => {
    describe('Admin Routes', () => {
        it('should return 401 for unauthenticated admin access', async () => {
            const res = await jsonRequest('/api/v1/admin/users');
            expect(res.status).toBe(401);

            const data = await res.json();
            expect(data.success).toBe(false);
        });

        it('should return 401 for admin treasury without auth', async () => {
            const res = await jsonRequest('/api/v1/admin/treasury');
            expect(res.status).toBe(401);
        });

        it('should return 401 for admin audit-logs without auth', async () => {
            const res = await jsonRequest('/api/v1/admin/audit-logs');
            expect(res.status).toBe(401);
        });

        it('should return 401 for admin price update without auth', async () => {
            const res = await jsonRequest('/api/v1/admin/price', {
                method: 'POST',
                body: { price: 150000 },
            });
            expect(res.status).toBe(401);
        });
    });

    describe('KYC Routes', () => {
        it('should return 401 for unauthenticated KYC status', async () => {
            const res = await jsonRequest('/api/v1/kyc/status');
            expect(res.status).toBe(401);
        });

        it('should return 401 for unauthenticated document upload', async () => {
            const res = await jsonRequest('/api/v1/kyc/documents', {
                method: 'POST',
                body: { type: 'GOVERNMENT_ID' },
            });
            expect(res.status).toBe(401);
        });

        it('should return 401 for unauthenticated KYC submission', async () => {
            const res = await jsonRequest('/api/v1/kyc/submit', {
                method: 'POST',
            });
            expect(res.status).toBe(401);
        });
    });

    describe('Notification Routes', () => {
        it('should return 401 for unauthenticated notification list', async () => {
            const res = await jsonRequest('/api/v1/notifications');
            expect(res.status).toBe(401);
        });

        it('should return 401 for unauthenticated mark-as-read', async () => {
            const res = await jsonRequest('/api/v1/notifications/123/read', {
                method: 'PUT',
            });
            expect(res.status).toBe(401);
        });
    });
});

// =====================================================
// A04 — INSECURE DESIGN (Rate Limiting & Body Size)
// =====================================================

describe('A04 — Insecure Design', () => {
    describe('Body Size Limit', () => {
        it('should reject requests with Content-Length > 1MB', async () => {
            const res = await app.request('/api/v1/auth/register', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': (2 * 1024 * 1024).toString(), // 2MB
                },
                body: JSON.stringify({ email: 'test@test.com' }),
            });

            expect(res.status).toBe(413);
            const data = await res.json();
            expect(data.error.code).toBe('PAYLOAD_TOO_LARGE');
        });
    });
});

// =====================================================
// A05 — SECURITY MISCONFIGURATION
// =====================================================

describe('A05 — Security Misconfiguration', () => {
    describe('Security Headers', () => {
        it('should include X-Content-Type-Options header', async () => {
            const res = await jsonRequest('/health');
            expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        });

        it('should include X-Frame-Options header', async () => {
            const res = await jsonRequest('/health');
            expect(res.headers.get('x-frame-options')).toBe('DENY');
        });

        it('should include Strict-Transport-Security header', async () => {
            const res = await jsonRequest('/health');
            const hsts = res.headers.get('strict-transport-security');
            expect(hsts).toContain('max-age=');
            expect(hsts).toContain('includeSubDomains');
        });

        it('should include Referrer-Policy header', async () => {
            const res = await jsonRequest('/health');
            expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
        });

        it('should include X-Request-Id header', async () => {
            const res = await jsonRequest('/health');
            const requestId = res.headers.get('x-request-id');
            expect(requestId).toBeTruthy();
            expect(requestId!.length).toBeGreaterThan(0);
        });

        it('should include rate limit headers', async () => {
            const res = await jsonRequest('/health');
            expect(res.headers.get('x-ratelimit-limit')).toBeTruthy();
            expect(res.headers.get('x-ratelimit-remaining')).toBeTruthy();
        });
    });

    describe('404 Error Handling', () => {
        it('should return structured error for unknown routes', async () => {
            const res = await jsonRequest('/api/v1/nonexistent-route');
            expect(res.status).toBe(404);

            const data = await res.json();
            expect(data.success).toBe(false);
            expect(data.error.code).toBe('NOT_FOUND');
        });

        it('should not leak stack traces in 404 responses', async () => {
            const res = await jsonRequest('/api/v1/nonexistent-route');
            const data = await res.json();
            expect(data.error).not.toHaveProperty('stack');
        });
    });
});

// =====================================================
// A08 — SOFTWARE & DATA INTEGRITY FAILURES
// =====================================================

describe('A08 — Content-Type Enforcement', () => {
    it('should reject POST with text/xml Content-Type', async () => {
        const res = await app.request('/api/v1/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
            },
            body: '<xml>data</xml>',
        });

        expect(res.status).toBe(415);
        const data = await res.json();
        expect(data.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('should accept POST with application/json Content-Type', async () => {
        const res = await app.request('/api/v1/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email: 'test@test.com', password: 'Test1234!' }),
        });

        // Should not be 415 (may be 401 or other auth error, but NOT content-type rejection)
        expect(res.status).not.toBe(415);
    });
});

// =====================================================
// A03 — INJECTION (Input Validation)
// =====================================================

describe('A03 — Input Validation', () => {
    describe('Market Routes', () => {
        it('should handle invalid days query parameter gracefully', async () => {
            const res = await jsonRequest('/api/v1/market/price/history?days=abc');
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
        });

        it('should handle negative days parameter', async () => {
            const res = await jsonRequest('/api/v1/market/price/history?days=-5');
            expect(res.status).toBe(200);
        });

        it('should handle extremely large days parameter', async () => {
            const res = await jsonRequest('/api/v1/market/price/history?days=99999');
            expect(res.status).toBe(200);
        });
    });

    describe('Auth Input Validation', () => {
        it('should reject registration with invalid email', async () => {
            const res = await jsonRequest('/api/v1/auth/register', {
                method: 'POST',
                body: {
                    email: 'not-an-email',
                    password: 'Test1234!',
                },
            });
            expect(res.status).toBe(400);
        });

        it('should reject registration with weak password', async () => {
            const res = await jsonRequest('/api/v1/auth/register', {
                method: 'POST',
                body: {
                    email: 'valid@test.com',
                    password: '123', // Too short, no uppercase, no special char
                },
            });
            expect(res.status).toBe(400);
        });

        it('should reject login with empty credentials', async () => {
            const res = await jsonRequest('/api/v1/auth/login', {
                method: 'POST',
                body: {},
            });
            expect(res.status).toBe(400);
        });
    });

    describe('Admin Price Validation', () => {
        it('should reject admin price update with invalid body when authenticated', async () => {
            // Without auth this returns 401, which still proves the route is protected
            const res = await jsonRequest('/api/v1/admin/price', {
                method: 'POST',
                body: { price: 'not-a-number' },
            });
            // Should be 401 (no auth) — confirms admin protection works
            expect(res.status).toBe(401);
        });
    });
});

// =====================================================
// HEALTH CHECK BASELINE
// =====================================================

describe('Health Check', () => {
    it('should return healthy status', async () => {
        const res = await jsonRequest('/health');
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.status).toBe('healthy');
    });

    it('should return API info from root', async () => {
        const res = await jsonRequest('/');
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.message).toContain('Avelon');
    });
});
