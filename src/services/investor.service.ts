import { prisma } from '../lib/prisma.js';
import { AppError, NotFoundError, ValidationError } from '../middleware/error.middleware.js';
import { DepositStatus } from '../types/index.js';
import { chain } from '../config/env.js';
import { blockchainService } from './blockchain.service.js';
import { poolService } from './pool.service.js';
import { Prisma } from '../generated/prisma/client.js';

const PrismaDecimal = Prisma.Decimal;

// =====================================================
// INVESTOR SERVICE
//
// Positions are read from AvelonLiquidityPool, never from the database. The
// investor signs their own deposit, withdrawal and yield claim; this service only
// verifies the resulting transaction and files it in the ledger. Nothing here can
// move an investor's funds.
// =====================================================

type PoolAction = 'deposit' | 'withdraw' | 'claim';

export class InvestorService {
    /**
     * The verified wallet an investor acts from. Deposits from an unverified or
     * unregistered address are not attributable to a user, so they are rejected
     * rather than credited to whoever asked.
     */
    private async getVerifiedWallet(userId: string, address: string) {
        const wallet = await prisma.wallet.findFirst({
            where: { userId, address: { equals: address, mode: 'insensitive' } },
        });
        if (!wallet) {
            throw new ValidationError('That address is not registered to this account');
        }
        if (!wallet.isVerified) {
            throw new ValidationError('Wallet ownership has not been verified. Sign the connection challenge first.');
        }
        if (wallet.chainId !== chain.id) {
            throw new ValidationError(`Wallet is registered on chain ${wallet.chainId}, expected ${chain.id}`);
        }
        return wallet;
    }

    /**
     * Shared checks for any investor-signed pool transaction: right chain, right
     * sender, right contract, right method, confirmed, and not already filed.
     */
    private async verifyPoolTransaction(
        userId: string,
        txHash: string,
        action: PoolAction,
    ): Promise<{ address: string; blockNumber: number; value: string }> {
        const poolAddress = poolService.getAddress();
        if (!poolAddress) {
            throw new AppError(503, 'INVESTOR_POOL_UNAVAILABLE', 'No liquidity pool is configured.');
        }

        if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
            throw new ValidationError('Transaction hash is malformed');
        }

        const already = await prisma.poolTransaction.findFirst({ where: { txHash } });
        if (already) {
            throw new ValidationError('This transaction has already been recorded');
        }

        const info = await blockchainService.verifyTransaction(txHash);
        if (!info.valid) {
            throw new ValidationError(
                `Transaction is not successful or has fewer than ${chain.minConfirmations} confirmation(s)`,
            );
        }
        if (info.chainId !== chain.id) {
            throw new ValidationError(`Transaction is on chain ${info.chainId}, expected ${chain.id}`);
        }
        if (info.to?.toLowerCase() !== poolAddress.toLowerCase()) {
            throw new ValidationError('Transaction was not sent to the Avelon liquidity pool');
        }
        if (!info.from) {
            throw new ValidationError('Transaction sender is unavailable');
        }

        await this.getVerifiedWallet(userId, info.from);

        const expectedMethod = { deposit: 'deposit', withdraw: 'withdraw', claim: 'claimYield' }[action];
        const call = info.data ? blockchainService.decodePoolCall(info.data) : null;
        if (!call || call.name !== expectedMethod) {
            throw new ValidationError(`Transaction does not call ${expectedMethod}() on the pool`);
        }

        return {
            address: info.from,
            blockNumber: info.blockNumber ?? 0,
            value: info.value ?? '0',
        };
    }

    // ============================================
    // POOL STATS
    // ============================================

    async getPoolStats() {
        const pool = await this._getOrCreatePool();

        const [investors, activeLoans] = await Promise.all([
            prisma.investorDeposit.groupBy({
                by: ['userId'],
                where: { status: DepositStatus.CONFIRMED },
                _count: true,
            }),
            prisma.loan.count({ where: { status: { in: ['ACTIVE', 'COLLATERAL_DEPOSITED'] } } }),
        ]);

        if (!poolService.isConfigured()) {
            return {
                tvl: 0,
                availableLiquidity: 0,
                totalBorrowed: 0,
                utilizationRate: 0,
                apy: 0,
                totalInvestors: investors.length,
                activeLoans,
                lastUpdated: pool.lastUpdated,
                poolAddress: null,
                custodyMode: 'UNCONFIGURED' as const,
                depositsEnabled: false,
                withdrawalsEnabled: false,
            };
        }

        const state = await poolService.getPoolState();

        return {
            tvl: Number(state.totalAssets),
            availableLiquidity: Number(state.availableLiquidity),
            totalBorrowed: Number(state.totalOutstandingPrincipal),
            utilizationRate: state.utilization,
            // Realised, not projected: interest actually received over what the pool
            // is worth. There is no forward APY promise here.
            apy: this._realisedReturn(state.cumulativeInterest, state.totalAssets),
            totalInvestors: investors.length,
            activeLoans,
            cumulativeInterest: Number(state.cumulativeInterest),
            cumulativeWriteOffs: Number(state.cumulativeWriteOffs),
            lastUpdated: new Date(),
            poolAddress: state.address,
            // Investors sign their own transactions — Avelon holds no investor key.
            custodyMode: 'SELF_CUSTODY_ONCHAIN' as const,
            depositsEnabled: true,
            withdrawalsEnabled: true,
        };
    }

    /** Interest received to date over current pool size. Backward-looking. */
    private _realisedReturn(cumulativeInterest: string, totalAssets: string): number {
        const assets = Number(totalAssets);
        if (assets <= 0) return 0;
        return Number(cumulativeInterest) / assets;
    }

    // ============================================
    // DASHBOARD
    // ============================================

    async getDashboard(userId: string) {
        const [wallets, poolStats, recentTransactions] = await Promise.all([
            prisma.wallet.findMany({
                where: { userId, isVerified: true },
                orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            }),
            this.getPoolStats(),
            prisma.poolTransaction.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                take: 10,
            }),
        ]);

        const position = await this.getPosition(userId, wallets);

        return {
            ...position,
            pool: poolStats,
            recentTransactions: recentTransactions.map((t) => ({
                id: t.id,
                type: t.type,
                amount: Number(t.amount),
                txHash: t.txHash,
                sharesDelta: t.sharesDelta ? Number(t.sharesDelta) : null,
                userId: t.userId,
                createdAt: t.createdAt,
            })),
        };
    }

    /**
     * Live position across every verified wallet the investor holds, read straight
     * from the pool contract.
     */
    async getPosition(userId: string, preloadedWallets?: { address: string }[]) {
        const wallets =
            preloadedWallets ??
            (await prisma.wallet.findMany({ where: { userId, isVerified: true }, select: { address: true } }));

        const empty = {
            walletAddress: null as string | null,
            shares: 0,
            totalDeposited: 0,
            currentValue: 0,
            totalYieldEarned: 0,
            claimableYield: 0,
            maxWithdrawable: 0,
            poolConfigured: poolService.isConfigured(),
        };

        if (!poolService.isConfigured() || wallets.length === 0) return empty;

        const positions = await Promise.all(
            wallets.map(async (w) => ({ address: w.address, ...(await poolService.getPosition(w.address)) })),
        );

        const sum = (pick: (p: (typeof positions)[number]) => string) =>
            positions.reduce((total, p) => total + Number(pick(p)), 0);

        // The wallet actually holding the position, so the UI can tell the investor
        // which one to sign a withdrawal from.
        const funded = positions.find((p) => Number(p.shares) > 0) ?? positions[0];

        return {
            walletAddress: funded.address,
            shares: sum((p) => p.shares),
            totalDeposited: sum((p) => p.depositedPrincipal),
            currentValue: sum((p) => p.currentValue),
            totalYieldEarned: sum((p) => p.yieldEarned),
            claimableYield: sum((p) => p.yieldEarned),
            maxWithdrawable: sum((p) => p.maxWithdrawable),
            poolConfigured: true,
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
            sharesMinted: d.sharesMinted ? Number(d.sharesMinted) : null,
            blockNumber: d.blockNumber,
            poolSharePercent: d.poolSharePercent,
            createdAt: d.createdAt,
            withdrawnAt: d.withdrawnAt,
        }));
    }

    /**
     * File a deposit the investor already signed and sent.
     *
     * The amount and the shares both come from the pool's own Deposited event, not
     * from the request body, so a client cannot claim more than it paid.
     */
    async recordDeposit(userId: string, txHash: string) {
        const { address, blockNumber } = await this.verifyPoolTransaction(userId, txHash, 'deposit');

        const existing = await prisma.investorDeposit.findUnique({ where: { txHash } });
        if (existing) {
            throw new ValidationError('This deposit has already been recorded');
        }

        const event = await blockchainService.findPoolEvent(
            txHash,
            poolService.getAddress()!,
            'Deposited',
            address,
        );
        if (!event) {
            throw new ValidationError('No matching Deposited event for this wallet in that transaction');
        }

        const state = await poolService.getPoolState();
        const sharePercent =
            Number(state.totalShares) > 0 ? (Number(event.shares) / Number(state.totalShares)) * 100 : 100;

        const [deposit] = await prisma.$transaction([
            prisma.investorDeposit.create({
                data: {
                    userId,
                    amount: new PrismaDecimal(event.assets),
                    txHash,
                    status: DepositStatus.CONFIRMED,
                    sharesMinted: new PrismaDecimal(event.shares),
                    blockNumber,
                    poolSharePercent: sharePercent,
                },
            }),
            prisma.poolTransaction.create({
                data: {
                    type: 'DEPOSIT',
                    amount: new PrismaDecimal(event.assets),
                    sharesDelta: new PrismaDecimal(event.shares),
                    txHash,
                    userId,
                },
            }),
            prisma.auditLog.create({
                data: {
                    userId,
                    action: 'INVESTOR_DEPOSIT',
                    entity: 'InvestorDeposit',
                    entityId: txHash,
                    metadata: { txHash, amount: event.assets, shares: event.shares, address },
                },
            }),
        ]);

        await this._syncPoolMirror();

        return {
            id: deposit.id,
            amount: Number(event.assets),
            sharesMinted: Number(event.shares),
            txHash,
            status: DepositStatus.CONFIRMED,
        };
    }

    // ============================================
    // WITHDRAWALS AND YIELD
    // ============================================

    /**
     * File a withdrawal the investor already signed. The pool paid them directly;
     * this only records what happened and marks deposits as withdrawn once the
     * position is empty.
     */
    async recordWithdrawal(userId: string, txHash: string) {
        const { address } = await this.verifyPoolTransaction(userId, txHash, 'withdraw');

        const event = await blockchainService.findPoolEvent(
            txHash,
            poolService.getAddress()!,
            'Withdrawn',
            address,
        );
        if (!event) {
            throw new ValidationError('No matching Withdrawn event for this wallet in that transaction');
        }

        await prisma.poolTransaction.create({
            data: {
                type: 'WITHDRAWAL',
                amount: new PrismaDecimal(event.assets),
                sharesDelta: new PrismaDecimal(`-${event.shares}`),
                txHash,
                userId,
            },
        });

        // A position back at zero means every deposit behind it is now closed.
        const remaining = await poolService.getPosition(address);
        if (Number(remaining.shares) === 0) {
            await prisma.investorDeposit.updateMany({
                where: { userId, status: DepositStatus.CONFIRMED },
                data: { status: DepositStatus.WITHDRAWN, withdrawnAt: new Date() },
            });
        }

        await prisma.auditLog.create({
            data: {
                userId,
                action: 'INVESTOR_WITHDRAWAL',
                entity: 'PoolTransaction',
                entityId: txHash,
                metadata: { txHash, amount: event.assets, shares: event.shares, address },
            },
        });

        await this._syncPoolMirror();

        return { amount: Number(event.assets), sharesBurned: Number(event.shares), txHash };
    }

    /** File a yield claim the investor already signed. */
    async recordYieldClaim(userId: string, txHash: string) {
        const { address } = await this.verifyPoolTransaction(userId, txHash, 'claim');

        const event = await blockchainService.findPoolEvent(
            txHash,
            poolService.getAddress()!,
            'YieldClaimed',
            address,
        );
        if (!event) {
            throw new ValidationError('No matching YieldClaimed event for this wallet in that transaction');
        }

        await prisma.poolTransaction.create({
            data: {
                type: 'YIELD_CLAIMED',
                amount: new PrismaDecimal(event.assets),
                sharesDelta: new PrismaDecimal(`-${event.shares}`),
                txHash,
                userId,
            },
        });

        await prisma.auditLog.create({
            data: {
                userId,
                action: 'INVESTOR_YIELD_CLAIM',
                entity: 'PoolTransaction',
                entityId: txHash,
                metadata: { txHash, amount: event.assets, shares: event.shares, address },
            },
        });

        await this._syncPoolMirror();

        return { amount: Number(event.assets), sharesBurned: Number(event.shares), txHash };
    }

    /**
     * The calldata and target an investor's wallet has to sign. Returned so the web
     * and mobile clients never hand-assemble a function selector.
     */
    async getCallData(action: 'deposit' | 'claim' | 'withdraw', shares?: string) {
        const address = poolService.getAddress();
        if (!address) {
            throw new AppError(503, 'INVESTOR_POOL_UNAVAILABLE', 'No liquidity pool is configured.');
        }

        if (action === 'withdraw') {
            if (!shares || Number(shares) <= 0) {
                throw new ValidationError('shares must be greater than zero');
            }
            return { to: address, data: poolService.encodeCall('withdraw', shares), value: '0', chainId: chain.id };
        }

        return {
            to: address,
            data: poolService.encodeCall(action === 'deposit' ? 'deposit' : 'claimYield'),
            value: '0',
            chainId: chain.id,
        };
    }

    // ============================================
    // EARNINGS
    // ============================================

    async getEarnings(userId: string) {
        const position = await this.getPosition(userId);

        const claims = await prisma.poolTransaction.findMany({
            where: { userId, type: { in: ['YIELD_CLAIMED', 'YIELD_EARNED'] } },
            orderBy: { createdAt: 'asc' },
        });

        const monthlyMap = new Map<string, number>();
        for (const tx of claims) {
            const month = tx.createdAt.toISOString().slice(0, 7); // "YYYY-MM"
            monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + Number(tx.amount));
        }

        const claimed = claims.reduce((sum, t) => sum + Number(t.amount), 0);

        return {
            // Unrealised gain still sitting in the position, plus anything taken out
            totalEarned: position.totalYieldEarned + claimed,
            claimable: position.claimableYield,
            claimed,
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
                sharesDelta: t.sharesDelta ? Number(t.sharesDelta) : null,
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
            pool = await prisma.liquidityPool.create({ data: {} });
        }
        return pool;
    }

    /**
     * Copy the pool's on-chain figures into the LiquidityPool row.
     *
     * Reporting reads the chain directly; this mirror exists so admin analytics and
     * historical charts have something to join against. It is never read back as
     * the truth, so a failure here must not fail the investor's action.
     */
    private async _syncPoolMirror() {
        if (!poolService.isConfigured()) return;
        try {
            const state = await poolService.getPoolState();
            const pool = await this._getOrCreatePool();
            await prisma.liquidityPool.update({
                where: { id: pool.id },
                data: {
                    totalLiquidity: new PrismaDecimal(state.totalAssets),
                    totalBorrowed: new PrismaDecimal(state.totalOutstandingPrincipal),
                    cumulativeYield: new PrismaDecimal(state.cumulativeInterest),
                    utilizationRate: state.utilization,
                    apy: this._realisedReturn(state.cumulativeInterest, state.totalAssets),
                    poolAddress: state.address,
                },
            });
        } catch (err) {
            console.error('[InvestorService] Pool mirror sync failed:', err);
        }
    }
}

export const investorService = new InvestorService();
