import { ethers, Contract, JsonRpcProvider, NonceManager, Wallet, ContractTransactionResponse } from 'ethers';
import { BlockchainError } from '../middleware/error.middleware.js';
import { chain } from '../config/env.js';

// ============================================
// INLINE ABIs — no filesystem dependency
// ============================================

const AVELON_LENDING_ABI = [
    // Mutating
    { inputs: [{ internalType: 'address', name: 'borrower', type: 'address' }, { internalType: 'uint128', name: 'principal', type: 'uint128' }, { internalType: 'uint128', name: 'collateralRequired', type: 'uint128' }, { internalType: 'uint16', name: 'interestRate', type: 'uint16' }, { internalType: 'uint32', name: 'duration', type: 'uint32' }], name: 'createLoan', outputs: [{ internalType: 'uint32', name: '', type: 'uint32' }], stateMutability: 'nonpayable', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'uint128', name: 'amount', type: 'uint128' }], name: 'recordRepayment', outputs: [], stateMutability: 'nonpayable', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'cancelLoan', outputs: [], stateMutability: 'nonpayable', type: 'function' },
    // View
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'getLoan', outputs: [{ components: [{ internalType: 'address', name: 'borrower', type: 'address' }, { internalType: 'uint48', name: 'createdAt', type: 'uint48' }, { internalType: 'uint48', name: 'activatedAt', type: 'uint48' }, { internalType: 'uint48', name: 'dueDate', type: 'uint48' }, { internalType: 'uint32', name: 'duration', type: 'uint32' }, { internalType: 'uint16', name: 'interestRate', type: 'uint16' }, { internalType: 'uint8', name: 'status', type: 'uint8' }, { internalType: 'uint128', name: 'principal', type: 'uint128' }, { internalType: 'uint128', name: 'collateralRequired', type: 'uint128' }, { internalType: 'uint128', name: 'principalOwed', type: 'uint128' }, { internalType: 'uint128', name: 'interestOwed', type: 'uint128' }], internalType: 'struct AvelonLending.Loan', name: '', type: 'tuple' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'getTotalOwed', outputs: [{ internalType: 'uint128', name: '', type: 'uint128' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'address', name: 'borrower', type: 'address' }], name: 'getBorrowerLoans', outputs: [{ internalType: 'uint32[]', name: '', type: 'uint32[]' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'isOverdue', outputs: [{ internalType: 'bool', name: '', type: 'bool' }], stateMutability: 'view', type: 'function' },
    { inputs: [], name: 'getCurrentLoanId', outputs: [{ internalType: 'uint32', name: '', type: 'uint32' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'getLoanBorrowerAndStatus', outputs: [{ internalType: 'address', name: 'borrower', type: 'address' }, { internalType: 'uint8', name: 'status', type: 'uint8' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'getLoanCollateralRequired', outputs: [{ internalType: 'uint128', name: '', type: 'uint128' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'getLoanOwed', outputs: [{ internalType: 'uint128', name: 'principalOwed', type: 'uint128' }, { internalType: 'uint128', name: 'interestOwed', type: 'uint128' }], stateMutability: 'view', type: 'function' },
    // Events
    { anonymous: false, inputs: [{ indexed: true, internalType: 'uint32', name: 'loanId', type: 'uint32' }, { indexed: true, internalType: 'address', name: 'borrower', type: 'address' }, { internalType: 'uint128', name: 'principal', type: 'uint128' }, { internalType: 'uint128', name: 'collateralRequired', type: 'uint128' }, { internalType: 'uint16', name: 'interestRate', type: 'uint16' }, { internalType: 'uint32', name: 'duration', type: 'uint32' }], name: 'LoanCreated', type: 'event' },
    { anonymous: false, inputs: [{ indexed: true, internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'uint48', name: 'activatedAt', type: 'uint48' }, { internalType: 'uint48', name: 'dueDate', type: 'uint48' }], name: 'LoanActivated', type: 'event' },
    { anonymous: false, inputs: [{ indexed: true, internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'uint128', name: 'amount', type: 'uint128' }, { internalType: 'uint128', name: 'remainingOwed', type: 'uint128' }], name: 'RepaymentRecorded', type: 'event' },
    { anonymous: false, inputs: [{ indexed: true, internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'uint48', name: 'repaidAt', type: 'uint48' }], name: 'LoanRepaid', type: 'event' },
    { anonymous: false, inputs: [{ indexed: true, internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'LoanCancelled', type: 'event' },
] as const;

const COLLATERAL_MANAGER_ABI = [
    // Mutating (owner)
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'releaseCollateral', outputs: [], stateMutability: 'nonpayable', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'uint8', name: 'reason', type: 'uint8' }, { internalType: 'uint16', name: 'observedRatioBps', type: 'uint16' }], name: 'liquidate', outputs: [], stateMutability: 'nonpayable', type: 'function' },
    // Mutating (borrower — payable)
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'depositCollateral', outputs: [], stateMutability: 'payable', type: 'function' },
    // View
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'getCollateral', outputs: [{ internalType: 'uint128', name: '', type: 'uint128' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'getCollateralRatio', outputs: [{ internalType: 'uint256', name: 'ratio', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'uint16', name: 'observedRatioBps', type: 'uint16' }], name: 'isAtRisk', outputs: [{ internalType: 'bool', name: 'warning', type: 'bool' }, { internalType: 'bool', name: 'liquidatable', type: 'bool' }], stateMutability: 'view', type: 'function' },
    { inputs: [], name: 'getBalance', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    // Events
    { anonymous: false, inputs: [{ indexed: true, internalType: 'uint32', name: 'loanId', type: 'uint32' }, { indexed: true, internalType: 'address', name: 'depositor', type: 'address' }, { internalType: 'uint128', name: 'amount', type: 'uint128' }], name: 'CollateralDeposited', type: 'event' },
    { anonymous: false, inputs: [{ indexed: true, internalType: 'uint32', name: 'loanId', type: 'uint32' }, { indexed: true, internalType: 'address', name: 'recipient', type: 'address' }, { internalType: 'uint128', name: 'amount', type: 'uint128' }], name: 'CollateralReleased', type: 'event' },
] as const;

const REPAYMENT_SCHEDULE_ABI = [
    // Mutating
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'uint128', name: 'totalAmount', type: 'uint128' }, { internalType: 'uint16', name: 'installments', type: 'uint16' }, { internalType: 'uint48', name: 'firstDueDate', type: 'uint48' }, { internalType: 'uint32', name: 'interval', type: 'uint32' }], name: 'createSchedule', outputs: [], stateMutability: 'nonpayable', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'uint128', name: 'amount', type: 'uint128' }, { internalType: 'bytes32', name: 'txHash', type: 'bytes32' }], name: 'recordPayment', outputs: [], stateMutability: 'nonpayable', type: 'function' },
    // View
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'getOutstanding', outputs: [{ internalType: 'uint128', name: '', type: 'uint128' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'getSchedule', outputs: [{ components: [{ internalType: 'uint128', name: 'totalAmount', type: 'uint128' }, { internalType: 'uint128', name: 'amountPaid', type: 'uint128' }, { internalType: 'uint128', name: 'installmentAmount', type: 'uint128' }, { internalType: 'uint48', name: 'nextDueDate', type: 'uint48' }, { internalType: 'uint32', name: 'interval', type: 'uint32' }, { internalType: 'uint16', name: 'installments', type: 'uint16' }, { internalType: 'bool', name: 'isComplete', type: 'bool' }], internalType: 'struct RepaymentSchedule.Schedule', name: '', type: 'tuple' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'isOverdue', outputs: [{ internalType: 'bool', name: '', type: 'bool' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'getPaymentCount', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    // Events
    { anonymous: false, inputs: [{ indexed: true, internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'uint128', name: 'totalAmount', type: 'uint128' }, { internalType: 'uint16', name: 'installments', type: 'uint16' }, { internalType: 'uint48', name: 'firstDueDate', type: 'uint48' }], name: 'ScheduleCreated', type: 'event' },
    { anonymous: false, inputs: [{ indexed: true, internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'uint128', name: 'amount', type: 'uint128' }, { internalType: 'uint128', name: 'remaining', type: 'uint128' }], name: 'PaymentRecorded', type: 'event' },
] as const;

const LIQUIDITY_POOL_ABI = [
    // Investor-signed
    { inputs: [], name: 'deposit', outputs: [], stateMutability: 'payable', type: 'function' },
    { inputs: [{ internalType: 'uint256', name: 'shareAmount', type: 'uint256' }], name: 'withdraw', outputs: [], stateMutability: 'nonpayable', type: 'function' },
    { inputs: [], name: 'claimYield', outputs: [], stateMutability: 'nonpayable', type: 'function' },
    // Borrower-signed
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'repay', outputs: [], stateMutability: 'payable', type: 'function' },
    // Owner
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'address', name: 'borrower', type: 'address' }, { internalType: 'uint256', name: 'amount', type: 'uint256' }], name: 'fundLoan', outputs: [], stateMutability: 'nonpayable', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'uint256', name: 'amount', type: 'uint256' }], name: 'writeOffLoan', outputs: [], stateMutability: 'nonpayable', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'recordRecovery', outputs: [], stateMutability: 'payable', type: 'function' },
    // View
    { inputs: [], name: 'totalAssets', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [], name: 'availableLiquidity', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [], name: 'totalShares', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [], name: 'totalOutstandingPrincipal', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [], name: 'cumulativeInterest', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [], name: 'cumulativeWriteOffs', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'address', name: '', type: 'address' }], name: 'shares', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'address', name: '', type: 'address' }], name: 'depositedPrincipal', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'address', name: 'investor', type: 'address' }], name: 'assetsOf', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'address', name: 'investor', type: 'address' }], name: 'yieldOf', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'address', name: 'investor', type: 'address' }], name: 'maxWithdrawableAssets', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: '', type: 'uint32' }], name: 'loanPrincipal', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    // Events
    { anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: 'investor', type: 'address' }, { internalType: 'uint256', name: 'assets', type: 'uint256' }, { internalType: 'uint256', name: 'sharesMinted', type: 'uint256' }], name: 'Deposited', type: 'event' },
    { anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: 'investor', type: 'address' }, { internalType: 'uint256', name: 'assets', type: 'uint256' }, { internalType: 'uint256', name: 'sharesBurned', type: 'uint256' }], name: 'Withdrawn', type: 'event' },
    { anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: 'investor', type: 'address' }, { internalType: 'uint256', name: 'assets', type: 'uint256' }, { internalType: 'uint256', name: 'sharesBurned', type: 'uint256' }], name: 'YieldClaimed', type: 'event' },
    { anonymous: false, inputs: [{ indexed: true, internalType: 'uint32', name: 'loanId', type: 'uint32' }, { indexed: true, internalType: 'address', name: 'borrower', type: 'address' }, { internalType: 'uint256', name: 'amount', type: 'uint256' }], name: 'LoanFunded', type: 'event' },
    { anonymous: false, inputs: [{ indexed: true, internalType: 'uint32', name: 'loanId', type: 'uint32' }, { internalType: 'uint256', name: 'principal', type: 'uint256' }, { internalType: 'uint256', name: 'interest', type: 'uint256' }], name: 'RepaymentReceived', type: 'event' },
] as const;

/**
 * A NonceManager that recovers from a failed send.
 *
 * The base class allocates the next nonce before the node accepts anything. When a
 * transaction is rejected — a revert caught during gas estimation, most often —
 * that nonce is never used, and every later send is one too high. The node then
 * refuses them all with "nonce too high", which reads like a bug in whatever ran
 * next rather than in the call that actually failed.
 */
class ResilientNonceManager extends NonceManager {
    async sendTransaction(tx: Parameters<NonceManager['sendTransaction']>[0]) {
        try {
            return await super.sendTransaction(tx);
        } catch (error) {
            this.reset();
            throw error;
        }
    }
}

/**
 * BlockchainService
 * Core service for blockchain connectivity and contract management
 */
export class BlockchainService {
    private provider: JsonRpcProvider;
    private readonly privateKey?: string;
    private _wallet: Wallet | null = null;
    private _signer: ResilientNonceManager | null = null;

    // Contract instances (lazy loaded)
    private _avelonLending: Contract | null = null;
    private _collateralManager: Contract | null = null;
    private _repaymentSchedule: Contract | null = null;
    private _liquidityPool: Contract | null = null;

    constructor() {
        // Resolved in config/env.ts, newest var name first
        this.privateKey = chain.privateKey;

        if (!this.privateKey) {
            console.warn('⚠️ No blockchain private key set (CHAIN_PRIVATE_KEY) - signing operations will fail');
        }

        this.provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.id);
    }

    /**
     * Build the signer on first use.
     *
     * This is deliberately not done in the constructor. The service is
     * instantiated at module scope, so a missing or malformed key used to throw
     * from `new ethers.Wallet()` during import and kill the whole process at
     * boot. Deferring it means the API still starts and every read-only chain
     * call keeps working; only signing fails, and it fails with a message that
     * names the variable to set.
     */
    private getWallet(): Wallet {
        if (this._wallet) return this._wallet;

        if (!this.privateKey) {
            throw new BlockchainError(
                'No signing key configured. Set CHAIN_PRIVATE_KEY in the backend .env.'
            );
        }

        try {
            this._wallet = new ethers.Wallet(this.privateKey, this.provider);
        } catch {
            // Don't surface the underlying ethers message — it can echo the key.
            throw new BlockchainError(
                'CHAIN_PRIVATE_KEY is not a valid private key (expected 32 bytes hex, optionally 0x-prefixed).'
            );
        }

        return this._wallet;
    }

    /**
     * The signer every write goes through.
     *
     * Wrapped in a NonceManager because the backend regularly sends two
     * transactions back to back — record a repayment, then release the collateral.
     * A bare Wallet asks the node for its nonce each time, and the node's answer
     * lags the transaction it only just accepted, so the second send reuses a spent
     * nonce and is rejected. The deploy script wraps its wallet for the same reason.
     */
    private getSignerInternal(): ResilientNonceManager {
        if (!this._signer) {
            this._signer = new ResilientNonceManager(this.getWallet());
        }
        return this._signer;
    }

    /**
     * Whether a usable signing key is configured. Lets callers and health
     * checks report the degraded state instead of triggering a throw.
     */
    hasSigner(): boolean {
        try {
            this.getWallet();
            return true;
        } catch {
            return false;
        }
    }

    // ============================================
    // PROVIDER & WALLET UTILITIES
    // ============================================

    /**
     * Get the JSON RPC provider
     */
    getProvider(): JsonRpcProvider {
        return this.provider;
    }

    /**
     * Get the signer wallet
     */
    getSigner(): ResilientNonceManager {
        return this.getSignerInternal();
    }

    /**
     * Get deployer/admin address
     */
    async getDeployerAddress(): Promise<string> {
        return this.getWallet().getAddress();
    }

    /**
     * Get current network information
     */
    async getNetworkInfo() {
        const network = await this.provider.getNetwork();
        return {
            name: network.name,
            chainId: network.chainId.toString(),
        };
    }

    /**
     * Get ETH balance for an address
     */
    async getBalance(address: string): Promise<string> {
        const balance = await this.provider.getBalance(address);
        return ethers.formatEther(balance);
    }

    /**
     * Get the transaction count (nonce) for an address.
     * Reflects the number of outgoing transactions sent from this address.
     */
    getTransactionCount(address: string): Promise<number> {
        return this.provider.getTransactionCount(address);
    }

    /**
     * Check if an address is valid
     */
    isValidAddress(address: string): boolean {
        return ethers.isAddress(address);
    }

    /**
     * Get current block number
     */
    getBlockNumber(): Promise<number> {
        return this.provider.getBlockNumber();
    }

    /**
     * Get transaction receipt
     */
    async getTransactionReceipt(txHash: string) {
        return this.provider.getTransactionReceipt(txHash);
    }

    /**
     * Wait for transaction confirmation
     */
    async waitForTransaction(txHash: string, confirmations = 1) {
        return this.provider.waitForTransaction(txHash, confirmations);
    }

    // ============================================
    // CONTRACT LOADING
    // ============================================

    /** Map of inline ABIs — no filesystem dependency */
    private static readonly CONTRACT_ABIS: Record<string, readonly object[]> = {
        AvelonLending: AVELON_LENDING_ABI,
        CollateralManager: COLLATERAL_MANAGER_ABI,
        RepaymentSchedule: REPAYMENT_SCHEDULE_ABI,
        AvelonLiquidityPool: LIQUIDITY_POOL_ABI,
    };

    /**
     * Get a contract instance backed by an inline ABI
     */
    getContract(contractName: string, address: string, useSigner = true): Contract {
        const abi = BlockchainService.CONTRACT_ABIS[contractName];
        if (!abi) {
            throw new Error(`Unknown contract: ${contractName}. Supported: ${Object.keys(BlockchainService.CONTRACT_ABIS).join(', ')}`);
        }
        const runner = useSigner ? this.getSignerInternal() : this.provider;
        return new ethers.Contract(address, abi as any[], runner);
    }

    // ============================================
    // DEPLOYED CONTRACT INSTANCES
    // ============================================

    /**
     * Get AvelonLending contract instance
     */
    getAvelonLending(): Contract {
        if (!this._avelonLending) {
            const address = process.env.AVELON_LENDING_ADDRESS;
            if (!address) {
                throw new Error('AVELON_LENDING_ADDRESS not configured');
            }
            this._avelonLending = this.getContract('AvelonLending', address);
        }
        return this._avelonLending;
    }

    /**
     * Get CollateralManager contract instance
     */
    getCollateralManager(): Contract {
        if (!this._collateralManager) {
            const address = process.env.COLLATERAL_MANAGER_ADDRESS;
            if (!address) {
                throw new Error('COLLATERAL_MANAGER_ADDRESS not configured');
            }
            this._collateralManager = this.getContract('CollateralManager', address);
        }
        return this._collateralManager;
    }

    /**
     * Get RepaymentSchedule contract instance
     */
    getRepaymentSchedule(): Contract {
        if (!this._repaymentSchedule) {
            const address = process.env.REPAYMENT_SCHEDULE_ADDRESS;
            if (!address) {
                throw new Error('REPAYMENT_SCHEDULE_ADDRESS not configured');
            }
            this._repaymentSchedule = this.getContract('RepaymentSchedule', address);
        }
        return this._repaymentSchedule;
    }

    /**
     * Get AvelonLiquidityPool contract instance
     */
    getLiquidityPool(): Contract {
        if (!this._liquidityPool) {
            const address = process.env.LIQUIDITY_POOL_ADDRESS;
            if (!address) {
                throw new Error('LIQUIDITY_POOL_ADDRESS not configured');
            }
            this._liquidityPool = this.getContract('AvelonLiquidityPool', address);
        }
        return this._liquidityPool;
    }

    /** Whether an investor pool address is configured at all. */
    hasLiquidityPool(): boolean {
        return !!process.env.LIQUIDITY_POOL_ADDRESS;
    }

    // ============================================
    // TRANSACTION UTILITIES
    // ============================================

    /**
     * Parse ETH amount to wei
     */
    parseEther(amount: string): bigint {
        return ethers.parseEther(amount);
    }

    /**
     * Format wei to ETH string
     */
    formatEther(wei: bigint): string {
        return ethers.formatEther(wei);
    }

    /**
     * Estimate gas for a transaction
     */
    async estimateGas(to: string, data: string, value = '0'): Promise<bigint> {
        return this.provider.estimateGas({
            to,
            data,
            value: ethers.parseEther(value),
        });
    }

    /**
     * Get current gas price
     */
    async getGasPrice(): Promise<bigint> {
        const feeData = await this.provider.getFeeData();
        return feeData.gasPrice || BigInt(0);
    }

    // ============================================
    // ETH TRANSFERS
    // ============================================

    /**
     * Send ETH from the treasury wallet to a recipient address.
     * Used for loan disbursement (treasury → borrower).
     */
    async sendEth(to: string, amountEth: string): Promise<{
        txHash: string;
        blockNumber: number;
        gasUsed: string;
    }> {
        const tx = await this.getSignerInternal().sendTransaction({
            to,
            value: ethers.parseEther(amountEth),
        });

        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
            throw new Error(`ETH transfer failed: tx ${tx.hash}`);
        }

        return {
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
        };
    }

    // ============================================
    // VERIFICATION UTILITIES
    // ============================================

    /**
     * Verify a transaction hash is valid and confirmed
     */
    async verifyTransaction(txHash: string): Promise<{
        valid: boolean;
        blockNumber?: number;
        chainId?: number;
        confirmations?: number;
        from?: string;
        to?: string;
        value?: string;
        data?: string;
        gasUsed?: string;
    }> {
        try {
            const receipt = await this.provider.getTransactionReceipt(txHash);

            if (!receipt) {
                return { valid: false };
            }

            const tx = await this.provider.getTransaction(txHash);
            if (!tx) {
                return { valid: false };
            }

            const network = await this.provider.getNetwork();
            const confirmations = await this.countConfirmations(receipt.blockNumber);

            return {
                valid: receipt.status === 1 && confirmations >= chain.minConfirmations,
                blockNumber: receipt.blockNumber,
                chainId: Number(network.chainId),
                confirmations,
                from: receipt.from,
                to: receipt.to || undefined,
                value: ethers.formatEther(tx.value),
                data: tx.data,
                gasUsed: receipt.gasUsed.toString(),
            };
        } catch (error) {
            return { valid: false };
        }
    }

    /**
     * Confirmations for a mined block, tolerating a provider that is momentarily
     * behind.
     *
     * ethers caches the head block number for a moment, so a transaction read back
     * immediately after it is mined can appear to be in the future and score zero
     * confirmations. That is indistinguishable from an unconfirmed transaction to
     * every caller, and on a local chain it happens constantly. Re-read a few times
     * before believing it.
     */
    private async countConfirmations(minedBlock: number, attempts = 4): Promise<number> {
        for (let i = 0; i < attempts; i++) {
            const head = await this.provider.getBlockNumber();
            if (head >= minedBlock) return head - minedBlock + 1;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return 0;
    }

    /**
     * Verify wallet message signature
     */
    verifySignature(message: string, signature: string): string {
        return ethers.verifyMessage(message, signature);
    }

    /** Decode a CollateralManager deposit call using the deployed ABI. */
    decodeCollateralDeposit(data: string): number | null {
        try {
            const parsed = new ethers.Interface(COLLATERAL_MANAGER_ABI).parseTransaction({ data });
            if (!parsed || parsed.name !== 'depositCollateral') return null;
            return Number(parsed.args[0]);
        } catch {
            return null;
        }
    }

    /** Decode a pool call, returning the function name and its first argument. */
    decodePoolCall(data: string): { name: string; args: readonly unknown[] } | null {
        try {
            const parsed = new ethers.Interface(LIQUIDITY_POOL_ABI).parseTransaction({ data });
            if (!parsed) return null;
            return { name: parsed.name, args: parsed.args };
        } catch {
            return null;
        }
    }

    /**
     * Find one pool event in a receipt, by name and investor.
     *
     * Returns the ETH amount and the share delta, both as decimal strings. Shares
     * are 18-decimal like ETH, so formatEther is the right conversion for both.
     */
    async findPoolEvent(
        txHash: string,
        poolAddress: string,
        eventName: 'Deposited' | 'Withdrawn' | 'YieldClaimed',
        investorAddress: string,
    ): Promise<{ assets: string; shares: string } | null> {
        const receipt = await this.provider.getTransactionReceipt(txHash);
        if (!receipt) return null;

        const iface = new ethers.Interface(LIQUIDITY_POOL_ABI);
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== poolAddress.toLowerCase()) continue;
            try {
                const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
                if (
                    parsed?.name === eventName &&
                    String(parsed.args.investor).toLowerCase() === investorAddress.toLowerCase()
                ) {
                    const shares = eventName === 'Deposited' ? parsed.args.sharesMinted : parsed.args.sharesBurned;
                    return {
                        assets: ethers.formatEther(parsed.args.assets),
                        shares: ethers.formatEther(shares),
                    };
                }
            } catch {
                // Ignore unrelated logs in the same receipt.
            }
        }
        return null;
    }

    /** Find the repayment the pool credited to a loan, if any. */
    async findPoolRepaymentEvent(
        txHash: string,
        poolAddress: string,
        loanId: number,
    ): Promise<{ principal: string; interest: string } | null> {
        const receipt = await this.provider.getTransactionReceipt(txHash);
        if (!receipt) return null;

        const iface = new ethers.Interface(LIQUIDITY_POOL_ABI);
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== poolAddress.toLowerCase()) continue;
            try {
                const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
                if (parsed?.name === 'RepaymentReceived' && Number(parsed.args.loanId) === loanId) {
                    return {
                        principal: ethers.formatEther(parsed.args.principal),
                        interest: ethers.formatEther(parsed.args.interest),
                    };
                }
            } catch {
                // Ignore unrelated logs in the same receipt.
            }
        }
        return null;
    }

    /** Find the exact deposit event emitted by CollateralManager. */
    async findCollateralDepositEvent(
        txHash: string,
        contractAddress: string,
        loanId: number,
        borrowerAddress: string,
    ): Promise<{ amount: string } | null> {
        const receipt = await this.provider.getTransactionReceipt(txHash);
        if (!receipt) return null;

        const iface = new ethers.Interface(COLLATERAL_MANAGER_ABI);
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
            try {
                const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
                if (
                    parsed?.name === 'CollateralDeposited' &&
                    Number(parsed.args.loanId) === loanId &&
                    String(parsed.args.depositor).toLowerCase() === borrowerAddress.toLowerCase()
                ) {
                    return { amount: ethers.formatEther(parsed.args.amount) };
                }
            } catch {
                // Ignore unrelated logs in the same receipt.
            }
        }
        return null;
    }
}

// Singleton instance
export const blockchainService = new BlockchainService();
