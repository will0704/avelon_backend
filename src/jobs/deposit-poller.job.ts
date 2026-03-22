import { prisma } from '../lib/prisma.js';
import { blockchainService } from '../services/blockchain.service.js';
import { investorService } from '../services/investor.service.js';

let isRunning = false;
const MAX_BATCH = 50;

/**
 * Poll PENDING investor deposits and auto-confirm those verified on-chain.
 */
export async function pollPendingDeposits(): Promise<void> {
    if (isRunning) return;
    isRunning = true;

    try {
        const pending = await prisma.investorDeposit.findMany({
            where: { status: 'PENDING' },
            take: MAX_BATCH,
            orderBy: { createdAt: 'asc' },
        });

        if (pending.length === 0) return;

        let confirmed = 0;

        for (const deposit of pending) {
            try {
                const txInfo = await blockchainService.verifyTransaction(deposit.txHash);
                if (!txInfo.valid) continue;

                await investorService.confirmDeposit(deposit.userId, deposit.txHash);
                confirmed++;
                console.log(`[DepositPoller] Auto-confirmed deposit ${deposit.id} (tx: ${deposit.txHash})`);
            } catch (err) {
                console.error(`[DepositPoller] Failed to process deposit ${deposit.id}:`, err);
            }
        }

        if (confirmed > 0) {
            console.log(`[DepositPoller] Processed ${pending.length} pending, confirmed ${confirmed}`);
        }
    } finally {
        isRunning = false;
    }
}
