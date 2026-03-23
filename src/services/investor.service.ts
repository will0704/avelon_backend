import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { NotFoundError, ValidationError } from '../middleware/error.middleware.js';
import { DepositStatus } from '../types/index.js';
import { blockchainService } from './blockchain.service.js';

// For Decimal type annotations
const PrismaDecimal = Prisma.Decimal;

// =====================================================
// INVESTOR SERVICE
// Handles investor deposits, withdrawals, earnings,
// and liquidity pool queries.
// =====================================================

export class InvestorService {
    // ============================================
    // POOL STATS
    // ============================================

    async getPoolStats() {
        console.log('[InvestorService] getPoolStats called');
        console.log('[InvestorService] COLLATERAL_MANAGER_ADDRESS env:', process.env.COLLATERAL_MANAGER_ADDRESS);

        const pool = await this._getOrCreatePool();

        // Count active investors (users with at least one CONFIRMED deposit and no withdrawal)
        const totalInvestors = await prisma.investorDeposit.groupBy({
            by: ['userId'],
            where: { status: DepositStatus.CONFIRMED },
            _count: true,
        });

        // Count active loans funded from pool
        const activeLoans = await prisma.loan.count({
            where: { status: { in: ['ACTIVE', 'COLLATERAL_DEPOSITED'] } },
        });

        const result = {
            tvl: Number(pool.totalLiquidity),
            totalBorrowed: Number(pool.totalBorrowed),
            utilizationRate: pool.utilizationRate,
            apy: pool.apy,
            totalInvestors: totalInvestors.length,
            activeLoans,
            lastUpdated: pool.lastUpdated,
            depositAddress: process.env.COLLATERAL_MANAGER_ADDRESS || null,
        };
        console.log('[InvestorService] getPoolStats result:', JSON.stringify(result, null, 2));
        return result;
    }

    // ============================================
    // DASHBOARD
    // ============================================

    async getDashboard(userId: string) {
        const [deposits, pool, recentTransactions] = await Promise.all([
            prisma.investorDeposit.findMany({
                where: { userId, status: { not: DepositStatus.WITHDRAWN } },
                orderBy: { createdAt: 'desc' },
            }),
            this._getOrCreatePool(),
            prisma.poolTransaction.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                take: 10,
            }),
        ]);

        const totalDeposited = deposits.reduce((sum, d) => sum + Number(d.amount), 0);

        // Estimate current value based on pool share and APY
        // Simple approximation: currentValue = deposited * (1 + earned_ratio)
        const yieldEarned = await this._calculateYieldEarned(userId, deposits);

        const poolStats = {
            tvl: Number(pool.totalLiquidity),
            totalBorrowed: Number(pool.totalBorrowed),
            utilizationRate: pool.utilizationRate,
            apy: pool.apy,
            totalInvestors: 0, // populated separately if needed
            activeLoans: 0,
            lastUpdated: pool.lastUpdated,
        };

        return {
            totalDeposited,
            currentValue: totalDeposited + yieldEarned.totalEarned,
            totalYieldEarned: yieldEarned.totalEarned,
            claimableYield: yieldEarned.claimable,
            pool: poolStats,
            recentTransactions: recentTransactions.map((t) => ({
                id: t.id,
                type: t.type,
                amount: Number(t.amount),
                txHash: t.txHash,
                userId: t.userId,
                createdAt: t.createdAt,
            })),
        };
    }

    // ============================================
    // DEPOSITS
    // ============================================

    async getDeposits(userId: string, status?: string) {
        const where: { userId: string; status?: DepositStatus } = { userId };
        if (status && Object.values(DepositStatus).includes(status as DepositStatus)) {
            where.status = status as DepositStatus;
        }

        const deposits = await prisma.investorDeposit.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        });

        return deposits.map((d) => ({
            id: d.id,
            amount: Number(d.amount),
            txHash: d.txHash,
            status: d.status,
            poolSharePercent: d.poolSharePercent,
            createdAt: d.createdAt,
            withdrawnAt: d.withdrawnAt,
        }));
    }

    async recordDeposit(userId: string, txHash: string, amount: string) {
        console.log('[InvestorService] recordDeposit called', { userId, txHash, amount });

        // Validate amount
        const amountDecimal = new PrismaDecimal(amount);
        if (amountDecimal.lte(0)) {
            console.error('[InvestorService] ❌ amount <= 0');
            throw new ValidationError('Deposit amount must be greater than 0');
        }

        // Check for duplicate tx
        const existing = await prisma.investorDeposit.findUnique({
            where: { txHash },
        });
        if (existing) {
            console.error('[InvestorService] ❌ duplicate txHash:', txHash);
            throw new ValidationError('Transaction already recorded');
        }

        // Get current pool share
        const pool = await this._getOrCreatePool();
        const poolTotalAfter = Number(pool.totalLiquidity) + Number(amount);
        const sharePercent = poolTotalAfter > 0 ? (Number(amount) / poolTotalAfter) * 100 : 100;
        console.log('[InvestorService] pool share calc:', { poolTotalAfter, sharePercent });

        const deposit = await prisma.investorDeposit.create({
            data: {
                userId,
                txHash,
                amount: amountDecimal,
                status: DepositStatus.PENDING,
                poolSharePercent: sharePercent,
            },
        });

        console.log('[InvestorService] ✅ deposit created:', deposit.id);
        return deposit;
    }

    async confirmDeposit(userId: string, txHash: string) {
        const deposit = await prisma.investorDeposit.findUnique({
            where: { txHash },
        });

        if (!deposit || deposit.userId !== userId) {
            throw new NotFoundError('Deposit not found');
        }

        if (deposit.status !== DepositStatus.PENDING) {
            throw new ValidationError('Deposit is not in PENDING state');
        }

        // Verify the transaction exists and is confirmed on-chain
        const txResult = await blockchainService.verifyTransaction(txHash);
        if (!txResult.valid) {
            throw new ValidationError('Transaction not confirmed on-chain');
        }

        const [updatedDeposit] = await prisma.$transaction([
            prisma.investorDeposit.update({
                where: { txHash },
                data: { status: DepositStatus.CONFIRMED },
            }),
            // Update pool liquidity
            prisma.liquidityPool.updateMany({
                data: {
                    totalLiquidity: { increment: deposit.amount },
                },
            }),
            // Record pool transaction
            prisma.poolTransaction.create({
                data: {
                    type: 'DEPOSIT',
                    amount: deposit.amount,
                    txHash,
                    userId,
                },
            }),
        ]);

        await this._recalculatePool();

        return updatedDeposit;
    }

    // ============================================
    // WITHDRAWALS
    // ============================================

    async withdraw(userId: string, depositId: string, walletAddress: string) {
        console.log('[InvestorService] withdraw called', { userId, depositId, walletAddress });

        const deposit = await prisma.investorDeposit.findUnique({
            where: { id: depositId },
        });

        if (!deposit || deposit.userId !== userId) {
            throw new NotFoundError('Deposit not found');
        }

        if (deposit.status !== DepositStatus.CONFIRMED) {
            throw new ValidationError('Only confirmed deposits can be withdrawn');
        }

        // Validate wallet address
        if (!blockchainService.isValidAddress(walletAddress)) {
            throw new ValidationError('Invalid wallet address');
        }

        // Check pool has enough liquidity
        const pool = await this._getOrCreatePool();
        const available = Number(pool.totalLiquidity) - Number(pool.totalBorrowed);
        const withdrawAmount = Number(deposit.amount);
        console.log('[InvestorService] pool liquidity check', { available, withdrawAmount });

        if (available < withdrawAmount) {
            throw new ValidationError('Insufficient pool liquidity for withdrawal. Try again later.');
        }

        // Send ETH on-chain from platform wallet to investor wallet
        console.log('[InvestorService] sending ETH on-chain...', { to: walletAddress, amount: withdrawAmount.toString() });
        const txResult = await blockchainService.sendEth(walletAddress, withdrawAmount.toString());
        console.log('[InvestorService] ✅ ETH sent', txResult);

        // Update DB records with tx hash
        const [updatedDeposit] = await prisma.$transaction([
            prisma.investorDeposit.update({
                where: { id: depositId },
                data: {
                    status: DepositStatus.WITHDRAWN,
                    withdrawnAt: new Date(),
                },
            }),
            prisma.liquidityPool.updateMany({
                data: {
                    totalLiquidity: { decrement: deposit.amount },
                },
            }),
            prisma.poolTransaction.create({
                data: {
                    type: 'WITHDRAWAL',
                    amount: deposit.amount,
                    txHash: txResult.txHash,
                    userId,
                },
            }),
        ]);

        await this._recalculatePool();

        console.log('[InvestorService] ✅ withdrawal complete', { depositId, txHash: txResult.txHash });
        return { ...updatedDeposit, txHash: txResult.txHash };
    }

    // ============================================
    // EARNINGS
    // ============================================

    async getEarnings(userId: string) {
        const deposits = await prisma.investorDeposit.findMany({
            where: { userId, status: { not: DepositStatus.WITHDRAWN } },
        });

        const yieldData = await this._calculateYieldEarned(userId, deposits);

        // Monthly breakdown from pool transactions
        const yieldTransactions = await prisma.poolTransaction.findMany({
            where: { userId, type: 'YIELD_EARNED' },
            orderBy: { createdAt: 'asc' },
        });

        const monthlyMap = new Map<string, number>();
        for (const tx of yieldTransactions) {
            const month = tx.createdAt.toISOString().slice(0, 7); // "YYYY-MM"
            monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + Number(tx.amount));
        }

        return {
            totalEarned: yieldData.totalEarned,
            claimable: yieldData.claimable,
            monthlyBreakdown: Array.from(monthlyMap.entries()).map(([month, earned]) => ({ month, earned })),
        };
    }

    // ============================================
    // TRANSACTIONS
    // ============================================

    async getTransactions(userId: string, page = 1, limit = 20) {
        const skip = (page - 1) * limit;

        const [transactions, total] = await Promise.all([
            prisma.poolTransaction.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.poolTransaction.count({ where: { userId } }),
        ]);

        return {
            transactions: transactions.map((t) => ({
                id: t.id,
                type: t.type,
                amount: Number(t.amount),
                txHash: t.txHash,
                userId: t.userId,
                createdAt: t.createdAt,
            })),
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
            },
        };
    }

    // ============================================
    // PRIVATE HELPERS
    // ============================================

    private async _getOrCreatePool() {
        let pool = await prisma.liquidityPool.findFirst();
        if (!pool) {
            pool = await prisma.liquidityPool.create({
                data: {},
            });
        }
        return pool;
    }

    private async _recalculatePool() {
        const pool = await this._getOrCreatePool();
        const total = Number(pool.totalLiquidity);
        const borrowed = Number(pool.totalBorrowed);
        const utilization = total > 0 ? borrowed / total : 0;

        // Simple APY model: base 5% + 10% * utilization (max 15%)
        const apy = 0.05 + 0.10 * utilization;

        await prisma.liquidityPool.updateMany({
            data: {
                utilizationRate: utilization,
                apy,
            },
        });
    }

    private async _calculateYieldEarned(userId: string, deposits: { amount: Prisma.Decimal; createdAt: Date }[]) {
        // Sum all YIELD_EARNED pool transactions for this user
        const yieldTxs = await prisma.poolTransaction.findMany({
            where: { userId, type: 'YIELD_EARNED' },
        });

        const totalEarned = yieldTxs.reduce((sum, t) => sum + Number(t.amount), 0);

        // For now claimable = total earned (no lock-up logic yet)
        return { totalEarned, claimable: totalEarned };
    }
}

export const investorService = new InvestorService();
