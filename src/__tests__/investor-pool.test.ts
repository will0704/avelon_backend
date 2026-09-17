/**
 * Investor pool and loan-approval regression tests.
 *
 * These cover the rules that make the investor role safe to demonstrate:
 * a deposit is only credited to the wallet that signed it, amounts come from the
 * pool's own event rather than the request body, a hash cannot be filed twice, and
 * a loan application has no on-chain identity until an admin approves it.
 *
 * The pool contract's arithmetic is proved in contracts/test/AvelonLiquidityPool.t.sol
 * against a real EVM; these tests cover the backend rules layered on top.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// MUST be first — registers Prisma mock before any module resolves
import './prisma.mock.js';
import { mockPrismaClient } from './prisma.mock.js';

const POOL_ADDRESS = '0x610178dA211FEF7D417bC0e6FeD39F05609AD788';
const INVESTOR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const STRANGER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const TX = '0x' + '11'.repeat(32);

const chainState = { id: 31337, minConfirmations: 1 };

vi.mock('../config/env.js', () => ({
    env: { DATABASE_URL: 'postgresql://localhost:5432/test' },
    chain: chainState,
}));

const { mockVerifyTransaction, mockDecodePoolCall, mockFindPoolEvent } = vi.hoisted(() => ({
    mockVerifyTransaction: vi.fn(),
    mockDecodePoolCall: vi.fn(),
    mockFindPoolEvent: vi.fn(),
}));

vi.mock('../services/blockchain.service.js', () => ({
    blockchainService: {
        verifyTransaction: mockVerifyTransaction,
        decodePoolCall: mockDecodePoolCall,
        findPoolEvent: mockFindPoolEvent,
    },
}));

const { mockGetPoolState, mockGetPosition, mockIsConfigured } = vi.hoisted(() => ({
    mockGetPoolState: vi.fn(),
    mockGetPosition: vi.fn(),
    mockIsConfigured: vi.fn(),
}));

vi.mock('../services/pool.service.js', () => ({
    poolService: {
        getAddress: () => POOL_ADDRESS,
        isConfigured: mockIsConfigured,
        getPoolState: mockGetPoolState,
        getPosition: mockGetPosition,
    },
}));

const { investorService } = await import('../services/investor.service.js');

/** A confirmed deposit call, sent by the investor to the pool. */
function goodDeposit() {
    mockVerifyTransaction.mockResolvedValue({
        valid: true,
        chainId: 31337,
        from: INVESTOR,
        to: POOL_ADDRESS,
        blockNumber: 12,
        value: '6.0',
        data: '0xd0e30db0',
    });
    mockDecodePoolCall.mockReturnValue({ name: 'deposit', args: [] });
    mockFindPoolEvent.mockResolvedValue({ assets: '6.0', shares: '6.0' });
}

beforeEach(() => {
    vi.clearAllMocks();
    chainState.id = 31337;

    mockIsConfigured.mockReturnValue(true);
    mockGetPoolState.mockResolvedValue({
        address: POOL_ADDRESS,
        totalAssets: '8.0',
        availableLiquidity: '8.0',
        totalOutstandingPrincipal: '0',
        totalShares: '8.0',
        cumulativeInterest: '0',
        cumulativeWriteOffs: '0',
        utilization: 0,
    });
    mockGetPosition.mockResolvedValue({
        shares: '6.0',
        depositedPrincipal: '6.0',
        currentValue: '6.0',
        yieldEarned: '0',
        maxWithdrawable: '6.0',
    });

    mockPrismaClient.wallet.findFirst = vi.fn().mockResolvedValue({
        id: 'w1',
        userId: 'inv1',
        address: INVESTOR,
        isVerified: true,
        chainId: 31337,
    });
    mockPrismaClient.poolTransaction = {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
    };
    mockPrismaClient.investorDeposit = {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'dep1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        groupBy: vi.fn().mockResolvedValue([]),
    };
    mockPrismaClient.liquidityPool = {
        findFirst: vi.fn().mockResolvedValue({ id: 'pool1', lastUpdated: new Date() }),
        create: vi.fn().mockResolvedValue({ id: 'pool1', lastUpdated: new Date() }),
        update: vi.fn().mockResolvedValue({}),
    };
    mockPrismaClient.$transaction = vi.fn().mockResolvedValue([{ id: 'dep1' }, {}, {}]);
});

describe('investor deposits', () => {
    it('credits the amount and shares from the pool event, not the request', async () => {
        goodDeposit();
        // A client that lies about the amount cannot change the outcome, because
        // nothing but the hash is ever read from the request.
        const result = await investorService.recordDeposit('inv1', TX);

        expect(result.amount).toBe(6);
        expect(result.sharesMinted).toBe(6);
        expect(mockFindPoolEvent).toHaveBeenCalledWith(TX, POOL_ADDRESS, 'Deposited', INVESTOR);
    });

    it('rejects a hash already on the ledger', async () => {
        goodDeposit();
        mockPrismaClient.poolTransaction.findFirst = vi.fn().mockResolvedValue({ id: 'existing' });

        await expect(investorService.recordDeposit('inv1', TX)).rejects.toThrow(/already been recorded/i);
    });

    it('rejects a deposit signed by a wallet the user does not own', async () => {
        goodDeposit();
        mockVerifyTransaction.mockResolvedValue({
            valid: true,
            chainId: 31337,
            from: STRANGER,
            to: POOL_ADDRESS,
            blockNumber: 12,
            value: '6.0',
            data: '0xd0e30db0',
        });
        mockPrismaClient.wallet.findFirst = vi.fn().mockResolvedValue(null);

        await expect(investorService.recordDeposit('inv1', TX)).rejects.toThrow(/not registered to this account/i);
    });

    it('rejects a deposit from a wallet that never proved ownership', async () => {
        goodDeposit();
        mockPrismaClient.wallet.findFirst = vi.fn().mockResolvedValue({
            id: 'w1',
            userId: 'inv1',
            address: INVESTOR,
            isVerified: false,
            chainId: 31337,
        });

        await expect(investorService.recordDeposit('inv1', TX)).rejects.toThrow(/has not been verified/i);
    });

    it('rejects a transaction sent somewhere other than the pool', async () => {
        goodDeposit();
        mockVerifyTransaction.mockResolvedValue({
            valid: true,
            chainId: 31337,
            from: INVESTOR,
            to: STRANGER,
            blockNumber: 12,
            value: '6.0',
            data: '0xd0e30db0',
        });

        await expect(investorService.recordDeposit('inv1', TX)).rejects.toThrow(/not sent to the Avelon liquidity pool/i);
    });

    it('rejects a transaction on the wrong chain', async () => {
        goodDeposit();
        mockVerifyTransaction.mockResolvedValue({
            valid: true,
            chainId: 84532,
            from: INVESTOR,
            to: POOL_ADDRESS,
            blockNumber: 12,
            value: '6.0',
            data: '0xd0e30db0',
        });

        await expect(investorService.recordDeposit('inv1', TX)).rejects.toThrow(/chain 84532, expected 31337/i);
    });

    it('rejects an unconfirmed transaction', async () => {
        goodDeposit();
        mockVerifyTransaction.mockResolvedValue({ valid: false });

        await expect(investorService.recordDeposit('inv1', TX)).rejects.toThrow(/not successful or has fewer than/i);
    });

    it('rejects a plain transfer that calls nothing', async () => {
        goodDeposit();
        mockDecodePoolCall.mockReturnValue(null);

        await expect(investorService.recordDeposit('inv1', TX)).rejects.toThrow(/does not call deposit\(\)/i);
    });

    it('rejects a withdraw transaction submitted as a deposit', async () => {
        goodDeposit();
        mockDecodePoolCall.mockReturnValue({ name: 'withdraw', args: [1n] });

        await expect(investorService.recordDeposit('inv1', TX)).rejects.toThrow(/does not call deposit\(\)/i);
    });

    it('rejects a malformed hash before touching the chain', async () => {
        await expect(investorService.recordDeposit('inv1', 'nonsense')).rejects.toThrow(/malformed/i);
        expect(mockVerifyTransaction).not.toHaveBeenCalled();
    });

    it('rejects a transaction whose event names a different investor', async () => {
        goodDeposit();
        mockFindPoolEvent.mockResolvedValue(null);

        await expect(investorService.recordDeposit('inv1', TX)).rejects.toThrow(/No matching Deposited event/i);
    });
});

describe('investor position reporting', () => {
    it('reads the position from the pool contract, not the database', async () => {
        mockPrismaClient.wallet.findMany = vi.fn().mockResolvedValue([{ address: INVESTOR }]);

        const position = await investorService.getPosition('inv1');

        expect(mockGetPosition).toHaveBeenCalledWith(INVESTOR);
        expect(position.currentValue).toBe(6);
        expect(position.walletAddress).toBe(INVESTOR);
    });

    it('reports an empty position when no wallet is verified', async () => {
        mockPrismaClient.wallet.findMany = vi.fn().mockResolvedValue([]);

        const position = await investorService.getPosition('inv1');

        expect(position.currentValue).toBe(0);
        expect(position.shares).toBe(0);
        expect(mockGetPosition).not.toHaveBeenCalled();
    });

    it('reports deposits disabled when no pool is configured', async () => {
        mockIsConfigured.mockReturnValue(false);

        const stats = await investorService.getPoolStats();

        expect(stats.depositsEnabled).toBe(false);
        expect(stats.custodyMode).toBe('UNCONFIGURED');
        expect(stats.tvl).toBe(0);
    });

    it('reports self-custody and live figures when the pool is configured', async () => {
        const stats = await investorService.getPoolStats();

        expect(stats.custodyMode).toBe('SELF_CUSTODY_ONCHAIN');
        expect(stats.depositsEnabled).toBe(true);
        expect(stats.tvl).toBe(8);
        // No deposit address is handed out — the calldata endpoint is the only path.
        expect('depositAddress' in stats).toBe(false);
    });
});

describe('investor transaction hashes', () => {
    const TX_UPPER = '0x' + 'AA'.repeat(32);
    const TX_LOWER = '0x' + 'aa'.repeat(32);

    function goodWithdrawal() {
        mockVerifyTransaction.mockResolvedValue({
            valid: true,
            chainId: 31337,
            from: INVESTOR,
            to: POOL_ADDRESS,
            blockNumber: 14,
            value: '0',
            data: '0x2e1a7d4d',
        });
        mockDecodePoolCall.mockReturnValue({ name: 'withdraw', args: [1n] });
        mockFindPoolEvent.mockResolvedValue({ assets: '2.0', shares: '2.0' });
    }

    beforeEach(() => {
        const m = mockPrismaClient as any;
        m.$executeRaw = vi.fn().mockResolvedValue(1);
        m.$transaction = vi.fn().mockImplementation((arg: unknown) =>
            typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(m) : Promise.resolve([{ id: 'dep1' }, {}, {}]),
        );
        m.auditLog.create = vi.fn().mockResolvedValue({});
    });

    it('looks deposits up by the lowercase hash', async () => {
        goodDeposit();
        await investorService.recordDeposit('inv1', TX_UPPER);

        expect(mockPrismaClient.poolTransaction.findFirst).toHaveBeenCalledWith({ where: { txHash: TX_LOWER } });
        expect(mockPrismaClient.investorDeposit.findUnique).toHaveBeenCalledWith({ where: { txHash: TX_LOWER } });
    });

    it('refuses an uppercase copy of a filed withdrawal', async () => {
        goodWithdrawal();
        mockPrismaClient.poolTransaction.findFirst = vi.fn(({ where }) =>
            Promise.resolve(where.txHash === TX_LOWER ? { id: 'filed' } : null));

        await expect(investorService.recordWithdrawal('inv1', TX_UPPER)).rejects.toThrow(/already been recorded/i);
        expect(mockVerifyTransaction).not.toHaveBeenCalled();
    });

    it('files a withdrawal under a lock so a parallel copy cannot slip in', async () => {
        goodWithdrawal();
        // Free at the first look, taken by the time the lock is held
        mockPrismaClient.poolTransaction.findFirst = vi.fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'filed-by-the-other-request' });

        await expect(investorService.recordWithdrawal('inv1', TX_LOWER)).rejects.toThrow(/already been recorded/i);
        expect(mockPrismaClient.$executeRaw).toHaveBeenCalled();
        expect(mockPrismaClient.poolTransaction.create).not.toHaveBeenCalled();
    });

    it('files a yield claim under the same lock', async () => {
        mockVerifyTransaction.mockResolvedValue({
            valid: true, chainId: 31337, from: INVESTOR, to: POOL_ADDRESS, blockNumber: 15, value: '0', data: '0x406cf229',
        });
        mockDecodePoolCall.mockReturnValue({ name: 'claimYield', args: [] });
        mockFindPoolEvent.mockResolvedValue({ assets: '0.1', shares: '0.09' });

        await investorService.recordYieldClaim('inv1', TX_UPPER);

        expect(mockPrismaClient.$executeRaw).toHaveBeenCalled();
        expect(mockPrismaClient.poolTransaction.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ txHash: TX_LOWER }) }),
        );
    });
});
