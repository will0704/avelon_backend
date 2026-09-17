import { Hono } from 'hono';
import { env, chain } from '../config/env.js';

const rpcRoutes = new Hono();

const LOCAL_CHAIN_ID = 31337;

// Phones can't reach the Hardhat node on 127.0.0.1, so their wallets use this as
// the network's RPC URL. Hardhat's accounts are unlocked, which makes a plain
// proxy an open faucet — only read calls and pre-signed transactions pass.
const ALLOWED_METHODS = new Set([
    'eth_chainId',
    'net_version',
    'web3_clientVersion',
    'eth_blockNumber',
    'eth_getBalance',
    'eth_getCode',
    'eth_getStorageAt',
    'eth_call',
    'eth_estimateGas',
    'eth_gasPrice',
    'eth_maxPriorityFeePerGas',
    'eth_feeHistory',
    'eth_getTransactionCount',
    'eth_getBlockByNumber',
    'eth_getBlockByHash',
    'eth_getTransactionByHash',
    'eth_getTransactionReceipt',
    'eth_getLogs',
    'eth_sendRawTransaction',
]);

interface RpcRequest {
    jsonrpc?: string;
    id?: unknown;
    method?: unknown;
}

function rejectMethod(req: RpcRequest) {
    return {
        jsonrpc: '2.0',
        id: req?.id ?? null,
        error: { code: -32601, message: `Method not available: ${String(req?.method)}` },
    };
}

async function forward(req: RpcRequest) {
    const res = await fetch(chain.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
    });
    return res.json();
}

async function handle(req: RpcRequest) {
    if (typeof req?.method !== 'string' || !ALLOWED_METHODS.has(req.method)) {
        return rejectMethod(req);
    }
    return forward(req);
}

rpcRoutes.post('/', async (c) => {
    // Local chain only; on a real deployment this route doesn't exist.
    if (chain.id !== LOCAL_CHAIN_ID || env.NODE_ENV === 'production') {
        return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    }

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }

    try {
        if (Array.isArray(body)) {
            if (body.length > 50) {
                return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch too large' } }, 400);
            }
            return c.json(await Promise.all(body.map((req) => handle(req as RpcRequest))));
        }
        return c.json(await handle(body as RpcRequest));
    } catch (err) {
        console.error('rpc proxy: node unreachable', err);
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Local chain unreachable' } }, 502);
    }
});

export { rpcRoutes };
