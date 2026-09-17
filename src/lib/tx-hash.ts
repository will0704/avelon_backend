import { ValidationError } from '../middleware/error.middleware.js';

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

// Nodes accept a hash in any letter case, so every stored or compared hash is
// lowercased first. Otherwise one transaction has 2^64 spellings that each pass
// a duplicate check.
export function normalizeTxHash(txHash: string): string {
    if (!TX_HASH.test(txHash)) {
        throw new ValidationError('Transaction hash is malformed');
    }
    return txHash.toLowerCase();
}

export function isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
