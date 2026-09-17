import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { localOnlyFlags } from '../config/exposure.js';

describe('development-only exposure', () => {
    it('exposes codes only on a development server nothing sits in front of', () => {
        expect(localOnlyFlags({ NODE_ENV: 'development', DEMO_EXPOSE_OTP: true, TRUSTED_PROXY_COUNT: 0 }))
            .toEqual({ isLocalOnly: true, exposeDemoOtp: true });
    });

    it('turns codes off once a tunnel or proxy is configured', () => {
        expect(localOnlyFlags({ NODE_ENV: 'development', DEMO_EXPOSE_OTP: true, TRUSTED_PROXY_COUNT: 1 }))
            .toEqual({ isLocalOnly: false, exposeDemoOtp: false });
    });

    it('never exposes codes in production', () => {
        expect(localOnlyFlags({ NODE_ENV: 'production', DEMO_EXPOSE_OTP: true, TRUSTED_PROXY_COUNT: 0 }).exposeDemoOtp).toBe(false);
    });
});

describe('error details', () => {
    it('hides stack traces from a development server behind a tunnel', async () => {
        vi.resetModules();
        vi.doMock('../config/env.js', () => ({
            env: { NODE_ENV: 'development', TRUSTED_PROXY_COUNT: 1 },
        }));
        const { errorHandler } = await import('../middleware/error.middleware.js');

        const app = new Hono();
        app.get('/boom', () => { throw new Error('database password is hunter2'); });
        app.onError(errorHandler);

        const body = await (await app.request('/boom')).json();
        expect(body.error.stack).toBeUndefined();
        expect(body.error.message).not.toMatch(/hunter2/);
        vi.doUnmock('../config/env.js');
    });
});
