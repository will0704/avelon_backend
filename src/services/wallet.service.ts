import { ethers } from 'ethers';
import { prisma } from '../lib/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../middleware/error.middleware.js';
import { UserStatus, LoanStatus } from '@avelon_capstone/types';

export class WalletService {
    /**
     * Generate a nonce message for wallet verification
     */
    generateNonceMessage(address: string): string {
        const nonce = Date.now();
        return `Welcome to Avelon!\n\nPlease sign this message to verify your wallet ownership.\n\nWallet: ${address}\nNonce: ${nonce}\n\nThis request will not trigger a blockchain transaction or cost any gas fees.`;
    }

    /**
     * Verify wallet signature
     */
    async verifySignature(
        userId: string,
        address: string,
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

        // Check if wallet already exists for another user
        const existingWallet = await prisma.wallet.findUnique({
            where: { address: address.toLowerCase() },
        });

        if (existingWallet && existingWallet.userId !== userId) {
            throw new ConflictError('This wallet is already linked to another account');
        }

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
            },
            create: {
                userId,
                address: address.toLowerCase(),
                isVerified: true,
                verifiedAt: new Date(),
                isPrimary: true, // First wallet is primary
            },
        });

        // Update user status if this is their first wallet
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { status: true },
        });

        if (user && user.status === UserStatus.VERIFIED) {
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

    /**
     * Get user's wallets
     */
    async getUserWallets(userId: string) {
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

        // Unset all other wallets as primary
        await prisma.wallet.updateMany({
            where: { userId, isPrimary: true },
            data: { isPrimary: false },
        });

        // Set this wallet as primary
        await prisma.wallet.update({
            where: { id: walletId },
            data: { isPrimary: true },
        });

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
    async getPrimaryWallet(userId: string) {
        return prisma.wallet.findFirst({
            where: { userId, isPrimary: true },
        });
    }
}

export const walletService = new WalletService();
