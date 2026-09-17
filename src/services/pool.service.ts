import { ethers } from 'ethers';
import { blockchainService } from './blockchain.service.js';
import { AppError, BlockchainError } from '../middleware/error.middleware.js';

/**
 * PoolService
 *
 * Thin wrapper over AvelonLiquidityPool. Every number the investor UI shows comes
 * from here rather than from the database, so a stale or diverged row can never
 * misreport what someone owns. The database keeps the event history; the chain
 * keeps the balances.
 *
 * Only two calls sign with the backend key — fundLoan and writeOffLoan. Investors
 * sign their own deposits, withdrawals and yield claims from their own wallets.
 */
export class PoolService {
    /** The deployed pool address, or null when the pool is not configured. */
    getAddress(): string | null {
        return process.env.LIQUIDITY_POOL_ADDRESS ?? null;
    }

    isConfigured(): boolean {
        return !!this.getAddress();
    }

    private requirePool() {
        if (!this.isConfigured()) {
            throw new AppError(
                503,
                'INVESTOR_POOL_UNAVAILABLE',
                'No liquidity pool is configured. Set LIQUIDITY_POOL_ADDRESS to a deployed AvelonLiquidityPool.',
            );
        }
        return blockchainService.getLiquidityPool();
    }

    // ============================================
    // READS
    // ============================================

    /**
     * Pool-wide figures, in ETH.
     *
     * utilization is outstanding principal over total assets — the share of the
     * pool that is working rather than idle.
     */
    async getPoolState(): Promise<{
        address: string;
        totalAssets: string;
        availableLiquidity: string;
        totalOutstandingPrincipal: string;
        totalShares: string;
        cumulativeInterest: string;
        cumulativeWriteOffs: string;
        utilization: number;
    }> {
        const pool = this.requirePool();
        const [assets, cash, outstanding, shares, interest, writeOffs] = await Promise.all([
            pool.totalAssets(),
            pool.availableLiquidity(),
            pool.totalOutstandingPrincipal(),
            pool.totalShares(),
            pool.cumulativeInterest(),
            pool.cumulativeWriteOffs(),
        ]);

        const assetsNum = Number(ethers.formatEther(assets));
        const outstandingNum = Number(ethers.formatEther(outstanding));

        return {
            address: this.getAddress()!,
            totalAssets: ethers.formatEther(assets),
            availableLiquidity: ethers.formatEther(cash),
            totalOutstandingPrincipal: ethers.formatEther(outstanding),
            totalShares: ethers.formatEther(shares),
            cumulativeInterest: ethers.formatEther(interest),
            cumulativeWriteOffs: ethers.formatEther(writeOffs),
            utilization: assetsNum > 0 ? outstandingNum / assetsNum : 0,
        };
    }

    /** One investor's live position, in ETH. */
    async getPosition(address: string): Promise<{
        shares: string;
        depositedPrincipal: string;
        currentValue: string;
        yieldEarned: string;
        maxWithdrawable: string;
    }> {
        const pool = this.requirePool();
        const [shares, basis, value, earned, withdrawable] = await Promise.all([
            pool.shares(address),
            pool.depositedPrincipal(address),
            pool.assetsOf(address),
            pool.yieldOf(address),
            pool.maxWithdrawableAssets(address),
        ]);

        return {
            shares: ethers.formatEther(shares),
            depositedPrincipal: ethers.formatEther(basis),
            currentValue: ethers.formatEther(value),
            yieldEarned: ethers.formatEther(earned),
            maxWithdrawable: ethers.formatEther(withdrawable),
        };
    }

    /** Principal still outstanding on one loan, in ETH. */
    async getLoanPrincipal(contractLoanId: number): Promise<string> {
        const pool = this.requirePool();
        return ethers.formatEther(await pool.loanPrincipal(contractLoanId));
    }

    // ============================================
    // OWNER-SIGNED WRITES
    // ============================================

    /**
     * Pay an approved loan out of the pool, straight to the borrower.
     *
     * Fails loudly when the pool is short rather than falling back to another
     * wallet — a loan the investors cannot fund is a loan that must not disburse.
     */
    async fundLoan(
        contractLoanId: number,
        borrowerAddress: string,
        amountEth: string,
    ): Promise<{ txHash: string; blockNumber: number; gasUsed: string }> {
        const pool = this.requirePool();
        const amount = ethers.parseEther(amountEth);

        const cash: bigint = await pool.availableLiquidity();
        if (cash < amount) {
            throw new AppError(
                409,
                'INSUFFICIENT_POOL_LIQUIDITY',
                `The investor pool holds ${ethers.formatEther(cash)} ETH but this loan needs ${amountEth} ETH. ` +
                'Disbursement is on hold until investors deposit more or borrowers repay.',
            );
        }

        try {
            const tx = await pool.fundLoan(contractLoanId, borrowerAddress, amount);
            const receipt = await tx.wait();
            if (receipt.status !== 1) {
                throw new BlockchainError(`fundLoan reverted in ${receipt.hash}`);
            }
            return {
                txHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString(),
            };
        } catch (error) {
            if (error instanceof AppError) throw error;
            const reason = error instanceof Error ? error.message : String(error);
            throw new BlockchainError(`Pool could not fund loan ${contractLoanId}: ${reason}`);
        }
    }

    /**
     * Write off principal the pool will not recover. No ETH moves — the loss lands
     * on share value and is split pro rata across investors.
     */
    async writeOffLoan(contractLoanId: number, amountEth: string): Promise<string> {
        const pool = this.requirePool();
        const tx = await pool.writeOffLoan(contractLoanId, ethers.parseEther(amountEth));
        const receipt = await tx.wait();
        return receipt.hash;
    }

    /**
     * Send a seized borrower stake on to the pool that funded the loan.
     *
     * CollateralManager pays liquidations to the lending contract's treasury, which
     * is the backend signer. Without this the stake would sit in that EOA while the
     * investors who actually lost the principal saw nothing back.
     */
    async recordRecovery(contractLoanId: number, amountEth: string): Promise<string> {
        const pool = this.requirePool();
        const tx = await pool.recordRecovery(contractLoanId, { value: ethers.parseEther(amountEth) });
        const receipt = await tx.wait();
        return receipt.hash;
    }

    // ============================================
    // CALLDATA FOR CLIENT-SIGNED TRANSACTIONS
    // ============================================

    /**
     * The exact call an investor or borrower has to sign. Handing back encoded
     * calldata keeps the function selector in one place instead of being rebuilt
     * by hand in the web and mobile clients.
     */
    encodeCall(fn: 'deposit' | 'claimYield'): string;
    encodeCall(fn: 'withdraw', shares: string): string;
    encodeCall(fn: 'repay', loanId: number): string;
    encodeCall(fn: string, arg?: string | number): string {
        const pool = this.requirePool();
        switch (fn) {
            case 'deposit':
                return pool.interface.encodeFunctionData('deposit');
            case 'claimYield':
                return pool.interface.encodeFunctionData('claimYield');
            case 'withdraw':
                return pool.interface.encodeFunctionData('withdraw', [ethers.parseEther(String(arg))]);
            case 'repay':
                return pool.interface.encodeFunctionData('repay', [Number(arg)]);
            default:
                throw new Error(`Unknown pool call: ${fn}`);
        }
    }
}

export const poolService = new PoolService();
