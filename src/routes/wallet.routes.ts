import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, verifiedMiddleware } from '../middleware/auth.middleware.js';
import { walletService } from '../services/wallet.service.js';

const walletRoutes = new Hono();

// Validation schemas
const connectWalletSchema = z.object({
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
    chainId: z.number().optional().default(1337),
});

const verifyWalletSchema = z.object({
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
    signature: z.string().min(1, 'Signature is required'),
    message: z.string().min(1, 'Message is required'),
});

/**
 * GET /wallets
 * List user's connected wallets
 */
walletRoutes.get('/', authMiddleware, async (c) => {
    const userId = c.get('userId');

    const wallets = await walletService.getUserWallets(userId);

    return c.json({
        success: true,
        data: wallets,
    });
});

/**
 * POST /wallets/connect
 * Initiate wallet connection - returns message to sign
 */
walletRoutes.post('/connect', authMiddleware, verifiedMiddleware, zValidator('json', connectWalletSchema), async (c) => {
    const { address } = c.req.valid('json');

    const message = walletService.generateNonceMessage(address);

    return c.json({
        success: true,
        data: {
            message,
            address,
        },
    });
});

/**
 * POST /wallets/verify
 * Verify wallet signature
 */
walletRoutes.post('/verify', authMiddleware, verifiedMiddleware, zValidator('json', verifyWalletSchema), async (c) => {
    const userId = c.get('userId');
    const { address, signature, message } = c.req.valid('json');

    const wallet = await walletService.verifySignature(userId, address, signature, message);

    return c.json({
        success: true,
        message: 'Wallet verified successfully',
        data: wallet,
    });
});

/**
 * PUT /wallets/:id/primary
 * Set wallet as primary
 */
walletRoutes.put('/:id/primary', authMiddleware, async (c) => {
    const userId = c.get('userId');
    const walletId = c.req.param('id');

    await walletService.setPrimary(userId, walletId);

    return c.json({
        success: true,
        message: 'Wallet set as primary',
    });
});

/**
 * DELETE /wallets/:id
 * Remove wallet
 */
walletRoutes.delete('/:id', authMiddleware, async (c) => {
    const userId = c.get('userId');
    const walletId = c.req.param('id');

    await walletService.removeWallet(userId, walletId);

    return c.json({
        success: true,
        message: 'Wallet removed',
    });
});

export { walletRoutes };
