import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../middleware/error.middleware.js';
import { UserStatus, LoanStatus } from '../types/index.js';

export class WalletService {
    /**
     * Generate a nonce message and persist the nonce for single-use verification
     */
    async generateAndStoreNonce(userId: string, address: string, chainId: number): Promise<string> {
        const normalizedAddress = address.toLowerCase();
        const nonce = randomBytes(32).toString('hex');
        const identifier = `wallet-nonce:${userId}:${normalizedAddress}:${chainId}`;
        const expires = new Date(Date.now() + 10 * 60 * 1_000);

        // Remove any stale nonce for this user+address, then store fresh one
        await prisma.verificationToken.deleteMany({
            where: { identifier, type: 'WALLET_NONCE' },
        });
        await prisma.verificationToken.create({
            data: {
                identifier,
                token: nonce,
                type: 'WALLET_NONCE',
                expires,
            },
        });

        return this.buildVerificationMessage(userId, normalizedAddress, chainId, nonce, expires);
    }

    /**
     * Verify wallet signature
     */
    async verifySignature(
        userId: string,
        address: string,
        chainId: number,
        signature: string,
        message: string
    ) {
        // Recover the address from signature
        let recoveredAddress: string;
        try {
            recoveredAddress = ethers.verifyMessage(message, signature);
        } catch (error) {
            throw new ValidationError('Invalid signature');
        }

        // Check if recovered address matches
        if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
            throw new ValidationError('Signature does not match wallet address');
        }

        // Validate nonce — prevents replay attacks (H-10)
        const normalizedAddress = address.toLowerCase();
        const nonceIdentifier = `wallet-nonce:${userId}:${normalizedAddress}:${chainId}`;
        const nonceRecord = await prisma.verificationToken.findFirst({
            where: { identifier: nonceIdentifier, type: 'WALLET_NONCE' },
        });
        if (!nonceRecord || new Date() > nonceRecord.expires) {
            throw new ValidationError('Nonce expired or not found — please request a new message');
        }
        const expectedMessage = this.buildVerificationMessage(
            userId,
            normalizedAddress,
            chainId,
            nonceRecord.token,
            nonceRecord.expires,
        );
        if (message !== expectedMessage) {
            throw new ValidationError('Verification message does not match the issued challenge');
        }
        // Consume atomically. Exactly one concurrent request can win.
        const consumed = await prisma.verificationToken.deleteMany({
            where: {
                token: nonceRecord.token,
                identifier: nonceIdentifier,
                type: 'WALLET_NONCE',
                expires: { gt: new Date() },
            },
        });
        if (consumed.count !== 1) {
            throw new ValidationError('Wallet challenge has already been used or expired');
        }

        // Check if wallet already exists for another user
        const existingWallet = await prisma.wallet.findUnique({
            where: { address: address.toLowerCase() },
        });

        if (existingWallet && existingWallet.userId !== userId) {
            throw new ConflictError('This wallet is already linked to another account');
        }

        // Only set as primary if user has no existing wallets
        const walletCount = await prisma.wallet.count({ where: { userId } });
        const isFirstWallet = walletCount === 0;

        // Upsert wallet
        const wallet = await prisma.wallet.upsert({
            where: {
                userId_address: {
                    userId,
                    address: address.toLowerCase(),
                },
            },
            update: {
                isVerified: true,
                verifiedAt: new Date(),
                lastUsedAt: new Date(),
                chainId,
            },
            create: {
                userId,
                address: address.toLowerCase(),
                chainId,
                isVerified: true,
                verifiedAt: new Date(),
                isPrimary: isFirstWallet,
            },
        });

        // Update user status if this is their first wallet
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { status: true },
        });

        if (user && user.status === UserStatus.APPROVED) {
            await prisma.user.update({
                where: { id: userId },
                data: { status: UserStatus.CONNECTED },
            });
        }

        // Log audit
        await prisma.auditLog.create({
            data: {
                userId,
                action: 'WALLET_CONNECTED',
                entity: 'Wallet',
                entityId: wallet.id,
                metadata: { address: wallet.address },
            },
        });

        return wallet;
    }

    private buildVerificationMessage(
        userId: string,
        address: string,
        chainId: number,
        nonce: string,
        expires: Date,
    ): string {
        return [
            'Avelon wallet ownership verification',
            `Audience: avelon.finance`,
            `User: ${userId}`,
            `Wallet: ${address}`,
            `Chain ID: ${chainId}`,
            `Nonce: ${nonce}`,
            `Expires: ${expires.toISOString()}`,
            '',
            'Signing proves wallet ownership. It does not submit a transaction or cost gas.',
        ].join('\n');
    }

    /**
     * Get user's wallets
     */
    getUserWallets(userId: string) {
        return prisma.wallet.findMany({
            where: { userId },
            orderBy: [
                { isPrimary: 'desc' },
                { createdAt: 'desc' },
            ],
        });
    }

    /**
     * Set wallet as primary
     */
    async setPrimary(userId: string, walletId: string) {
        // Check if wallet exists and belongs to user
        const wallet = await prisma.wallet.findFirst({
            where: { id: walletId, userId },
        });

        if (!wallet) {
            throw new NotFoundError('Wallet not found');
        }

        // Atomic: unset all primaries then set the new one
        await prisma.$transaction([
            prisma.wallet.updateMany({
                where: { userId, isPrimary: true },
                data: { isPrimary: false },
            }),
            prisma.wallet.update({
                where: { id: walletId },
                data: { isPrimary: true },
            }),
        ]);

        return { success: true };
    }

    /**
     * Remove wallet
     */
    async removeWallet(userId: string, walletId: string) {
        // Check if wallet exists and belongs to user
        const wallet = await prisma.wallet.findFirst({
            where: { id: walletId, userId },
        });

        if (!wallet) {
            throw new NotFoundError('Wallet not found');
        }

        // Check if wallet has active loans
        const activeLoans = await prisma.loan.count({
            where: {
                walletId,
                status: { in: [LoanStatus.PENDING_COLLATERAL, LoanStatus.COLLATERAL_DEPOSITED, LoanStatus.ACTIVE] },
            },
        });

        if (activeLoans > 0) {
            throw new ValidationError('Cannot remove wallet with active loans');
        }

        // Delete wallet
        await prisma.wallet.delete({
            where: { id: walletId },
        });

        // Log audit
        await prisma.auditLog.create({
            data: {
                userId,
                action: 'WALLET_REMOVED',
                entity: 'Wallet',
                entityId: walletId,
                metadata: { address: wallet.address },
            },
        });

        return { success: true };
    }

    /**
     * Get user's primary wallet
     */
    getPrimaryWallet(userId: string) {
        return prisma.wallet.findFirst({
            where: { userId, isPrimary: true },
        });
    }
}

export const walletService = new WalletService();
