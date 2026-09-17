/**
 * Platform behaviour the apps depend on: throttled responses a browser can read,
 * the phone-facing RPC proxy, and notifications that never fail a request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../app.js';
import { isRpcProxyEnabled } from '../routes/rpc.routes.js';

const ORIGIN = 'http://localhost:3000';

describe('throttled responses', () => {
    it('carry CORS headers so the browser shows the real error', async () => {
        let last: Response | undefined;
        for (let i = 0; i < 6; i++) {
            last = await app.request('/api/v1/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
                body: JSON.stringify({ email: 'not-an-email', password: '' }),
            });
        }
        expect(last!.status).toBe(429);
        expect(last!.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    });
});

describe('RPC proxy', () => {
    const node = vi.fn();

    beforeEach(() => {
        node.mockReset();
        node.mockImplementation(async (_url: string, init: RequestInit) => {
            const req = JSON.parse(String(init.body));
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: '0x7a69' }));
        });
        vi.stubGlobal('fetch', node);
    });
    afterEach(() => vi.unstubAllGlobals());

    function rpc(body: unknown) {
        return app.request('/api/v1/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        });
    }

    it.each(['eth_accounts', 'eth_sendTransaction', 'personal_sign', 'hardhat_setBalance', 'evm_mine', 'eth_sign'])(
        'refuses %s without asking the node',
        async (method) => {
            const body = await (await rpc({ jsonrpc: '2.0', id: 1, method, params: [] })).json();
            expect(body.error.code).toBe(-32601);
            expect(node).not.toHaveBeenCalled();
        },
    );

    it('forwards read calls and signed transactions', async () => {
        for (const method of ['eth_chainId', 'eth_getBalance', 'eth_sendRawTransaction', 'eth_estimateGas']) {
            const body = await (await rpc({ jsonrpc: '2.0', id: 7, method, params: [] })).json();
            expect(body.result).toBe('0x7a69');
        }
        expect(node).toHaveBeenCalledTimes(4);
    });

    it('answers each entry of a mixed batch', async () => {
        const body = await (await rpc([
            { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' },
            { jsonrpc: '2.0', id: 2, method: 'evm_mine' },
        ])).json();
        expect(body).toHaveLength(2);
        expect(body[0].result).toBe('0x7a69');
        expect(body[1].error.code).toBe(-32601);
    });

    it('refuses an oversized batch', async () => {
        const batch = Array.from({ length: 51 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_chainId' }));
        expect((await rpc(batch)).status).toBe(400);
        expect(node).not.toHaveBeenCalled();
    });

    it('refuses a body that is not JSON', async () => {
        expect((await rpc('{not json')).status).toBe(400);
    });

    it('reports an unreachable node as a JSON-RPC error', async () => {
        node.mockRejectedValue(new Error('ECONNREFUSED'));
        const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' });
        expect(res.status).toBe(502);
        expect((await res.json()).error.code).toBe(-32603);
    });

    it.each([
        [31337, 'development', true],
        [31337, 'production', false],
        [84532, 'development', false],
        [11155111, 'development', false],
    ])('is enabled for chain %i in %s: %s', (chainId, nodeEnv, expected) => {
        expect(isRpcProxyEnabled(chainId, nodeEnv)).toBe(expected);
    });
});

describe('notifications', () => {
    it('never fail the request that triggered them', async () => {
        vi.resetModules();
        vi.doMock('../lib/prisma.js', () => ({
            prisma: { notification: { create: vi.fn().mockRejectedValue(new Error('db down')) } },
        }));
        vi.doMock('../services/firebase.service.js', () => ({ firebaseService: { sendToMultiple: vi.fn() } }));
        const { notificationService } = await import('../services/notification.service.js');

        await expect(notificationService.notify('u1', { type: 'LOAN_APPROVED', title: 't', message: 'm' })).resolves.toBeUndefined();

        vi.doUnmock('../lib/prisma.js');
        vi.doUnmock('../services/firebase.service.js');
    });

    it('carry the loan id to the phone so a tap can open it', async () => {
        vi.resetModules();
        const send = vi.fn().mockResolvedValue([]);
        vi.doMock('../lib/prisma.js', () => ({
            prisma: {
                notification: { create: vi.fn().mockResolvedValue({}) },
                deviceToken: { findMany: vi.fn().mockResolvedValue([{ token: 't1' }]), updateMany: vi.fn() },
            },
        }));
        vi.doMock('../services/firebase.service.js', () => ({ firebaseService: { sendToMultiple: send } }));
        const { notificationService } = await import('../services/notification.service.js');

        await notificationService.notify('u1', { type: 'LOAN_APPROVED', title: 't', message: 'm', metadata: { loanId: 'l1', amount: 5 } });
        await vi.waitFor(() => expect(send).toHaveBeenCalled());

        expect(send.mock.calls[0][1].data).toEqual({ type: 'LOAN_APPROVED', loanId: 'l1' });
        vi.doUnmock('../lib/prisma.js');
        vi.doUnmock('../services/firebase.service.js');
    });
});
