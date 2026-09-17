import { Hono } from 'hono';
import { ethers } from 'ethers';
import { env, chain } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { blockchainService } from '../services/blockchain.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

const marketRoutes = new Hono();

/**
 * Gas per action, measured from the contract test suite
 * (`npm run hardhat:test -- --gas-stats`), median values.
 *
 * paidBy is the answer to revision 2: user-signed actions are paid by the member,
 * everything the backend signs is an operating cost AVELON absorbs.
 */
const ACTION_GAS = [
    { action: 'COLLATERAL_DEPOSIT', label: 'Lock your stake', paidBy: 'USER', gasUnits: 118181 },
    { action: 'ADD_COLLATERAL', label: 'Top up your stake', paidBy: 'USER', gasUnits: 118181 },
    { action: 'REPAYMENT', label: 'Make a repayment', paidBy: 'USER', gasUnits: 21000 },
    { action: 'INVESTOR_DEPOSIT', label: 'Deposit into the pool', paidBy: 'USER', gasUnits: 21000 },
    { action: 'LOAN_CREATION', label: 'Record the loan on-chain', paidBy: 'PLATFORM', gasUnits: 144287 },
    { action: 'DISBURSEMENT', label: 'Release the loan', paidBy: 'PLATFORM', gasUnits: 21000 },
    { action: 'REPAYMENT_RECORD', label: 'Record the repayment', paidBy: 'PLATFORM', gasUnits: 41782 },
    { action: 'COLLATERAL_RELEASE', label: 'Return the stake', paidBy: 'PLATFORM', gasUnits: 48618 },
    { action: 'LIQUIDATION', label: 'Seize the stake', paidBy: 'PLATFORM', gasUnits: 86086 },
    { action: 'INVESTOR_WITHDRAWAL', label: 'Pay out a withdrawal', paidBy: 'PLATFORM', gasUnits: 21000 },
] as const;

/** ETH/PHP from SystemConfig, falling back to the env default. */
async function getEthPhpRate(): Promise<number> {
    const configRate = await prisma.systemConfig.findUnique({
        where: { key: 'ETH_PHP_RATE' },
    });
    return configRate ? parseFloat(configRate.value) : env.ETH_PHP_RATE;
}

/**
 * GET /market/price
 * Get current ETH/PHP price from SystemConfig + latest PriceHistory
 */
marketRoutes.get('/price', async (c) => {
    // Get current rate from SystemConfig (admin-set value)
    const configRate = await prisma.systemConfig.findUnique({
        where: { key: 'ETH_PHP_RATE' },
    });

    // Get latest price history record for metadata
    const latestPrice = await prisma.priceHistory.findFirst({
        orderBy: { createdAt: 'desc' },
    });

    // Get the 24h-ago price for change calculation
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const previousPrice = await prisma.priceHistory.findFirst({
        where: { createdAt: { lte: oneDayAgo } },
        orderBy: { createdAt: 'desc' },
    });

    const currentPrice = configRate ? parseFloat(configRate.value) : env.ETH_PHP_RATE;
    const prevPrice = previousPrice ? Number(previousPrice.ethPricePHP) : currentPrice;
    const change24h = currentPrice - prevPrice;
    const changePercent24h = prevPrice > 0 ? (change24h / prevPrice) * 100 : 0;

    return c.json({
        success: true,
        data: {
            ethPricePHP: currentPrice,
            source: latestPrice?.source ?? 'manual',
            change24h: parseFloat(change24h.toFixed(2)),
            changePercent24h: parseFloat(changePercent24h.toFixed(4)),
            updatedAt: latestPrice?.createdAt ?? new Date().toISOString(),
        },
    });
});

/**
 * GET /market/price/history
 * Get price history with configurable time range
 */
marketRoutes.get('/price/history', async (c) => {
    const rawDays = parseInt(c.req.query('days') || '7', 10);
    const days = Math.min(365, Math.max(1, isNaN(rawDays) ? 7 : rawDays));

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const history = await prisma.priceHistory.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: {
            id: true,
            ethPricePHP: true,
            source: true,
            createdAt: true,
        },
    });

    const data = history.map((h) => ({
        id: h.id,
        ethPricePHP: Number(h.ethPricePHP),
        source: h.source,
        createdAt: h.createdAt,
    }));

    return c.json({
        success: true,
        data: {
            history: data,
        },
        meta: {
            days,
            total: data.length,
        },
    });
});

/**
 * GET /market/gas
 * Current gas price and what each action costs, split by who pays.
 */
marketRoutes.get('/gas', authMiddleware, async (c) => {
    const ethPricePHP = await getEthPhpRate();

    let gasPriceWei: bigint | null = null;
    try {
        gasPriceWei = await blockchainService.getGasPrice();
    } catch {
        // RPC down — still return the gas units so the UI can render the split
        gasPriceWei = null;
    }

    const actions = ACTION_GAS.map((a) => {
        if (gasPriceWei === null) {
            return { ...a, feeEth: null, feePHP: null };
        }
        const feeWei = gasPriceWei * BigInt(a.gasUnits);
        const feeEth = ethers.formatEther(feeWei);
        return {
            ...a,
            feeEth,
            feePHP: parseFloat((parseFloat(feeEth) * ethPricePHP).toFixed(4)),
        };
    });

    return c.json({
        success: true,
        data: {
            chainId: chain.id,
            explorerUrl: chain.explorerUrl,
            gasPriceWei: gasPriceWei?.toString() ?? null,
            gasPriceGwei: gasPriceWei === null ? null : parseFloat(ethers.formatUnits(gasPriceWei, 'gwei')),
            ethPricePHP,
            // On an L2 the posted gas price excludes the L1 data fee, so real cost
            // runs a little above these figures.
            actions,
        },
    });
});

export { marketRoutes };
