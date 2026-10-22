import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validate.js';
import { errorHandler } from '../middleware/error.middleware.js';

describe('request validation', () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.post('/loans', zValidator('json', z.object({ purpose: z.string().min(3, 'Purpose is too short') })), (c) => c.json({ ok: true }));

    it('answers with the first problem as a readable message, not a ZodError dump', async () => {
        const res = await app.request('/loans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'x' }) });
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.message).toBe('purpose: Purpose is too short');
        expect(JSON.stringify(body)).not.toContain('ZodError');
    });

    it('lets a valid request through', async () => {
        const res = await app.request('/loans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'Market stall' }) });
        expect(res.status).toBe(200);
    });
});
