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

/**
 * GET /wallets/:id/balance
 * Get wallet ETH balance from blockchain
 */
walletRoutes.get('/:id/balance', authMiddleware, async (c) => {
    const userId = c.get('userId');
    const walletId = c.req.param('id');

    // Import dynamically to avoid circular deps
    const { blockchainService } = await import('../services/blockchain.service.js');

    // Get wallet
    const wallets = await walletService.getUserWallets(userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
        return c.json({
            success: false,
            message: 'Wallet not found',
        }, 404);
    }

    try {
        const balance = await blockchainService.getBalance(wallet.address);

        return c.json({
            success: true,
            data: {
                address: wallet.address,
                balance,
                unit: 'ETH',
            },
        });
    } catch (error) {
        return c.json({
            success: true,
            data: {
                address: wallet.address,
                balance: null,
                error: 'Could not fetch balance from blockchain',
            },
        });
    }
});

/**
 * GET /wallets/balances
 * Get all wallet balances for user
 */
walletRoutes.get('/balances/all', authMiddleware, async (c) => {
    const userId = c.get('userId');

    const { blockchainService } = await import('../services/blockchain.service.js');

    const wallets = await walletService.getUserWallets(userId);

    const balances = await Promise.all(
        wallets.map(async (wallet) => {
            try {
                const balance = await blockchainService.getBalance(wallet.address);
                return {
                    id: wallet.id,
                    address: wallet.address,
                    balance,
                    isPrimary: wallet.isPrimary,
                };
            } catch {
                return {
                    id: wallet.id,
                    address: wallet.address,
                    balance: null,
                    isPrimary: wallet.isPrimary,
                };
            }
        })
    );

    return c.json({
        success: true,
        data: balances,
    });
});

export { walletRoutes };

