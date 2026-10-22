import { chain } from '../config/env.js';
import { blockchainService } from '../services/blockchain.service.js';

// The local Hardhat chain can be fast-forwarded for demos. Due-date checks and
// the loan jobs read time from here so they agree with what the contracts see.
// On any other chain this is plain wall-clock time.

export const LOCAL_CHAIN_ID = 31337;
export const isLocalChain = () => chain.id === LOCAL_CHAIN_ID;

let offsetMs = 0;

/** How far the local chain runs ahead of wall-clock time, refreshed from the node. */
export async function syncClock(): Promise<number> {
    if (!isLocalChain()) return 0;
    try {
        // Hardhat stamps the pending block with wall time plus every evm_increaseTime so far
        const block = await blockchainService.getProvider().send('eth_getBlockByNumber', ['pending', false]);
        const chainMs = Number(BigInt(block.timestamp)) * 1000;
        offsetMs = Math.max(0, chainMs - Date.now());
    } catch (err) {
        console.warn('[clock] Could not read chain time; keeping the last offset:', err instanceof Error ? err.message : err);
    }
    return offsetMs;
}

export function now(): Date {
    return new Date(Date.now() + offsetMs);
}

export function clockOffsetMs(): number {
    return offsetMs;
}
