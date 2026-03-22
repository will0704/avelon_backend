import { ethers, Contract, JsonRpcProvider, Wallet, ContractTransactionResponse } from 'ethers';

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
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'liquidate', outputs: [], stateMutability: 'nonpayable', type: 'function' },
    // Mutating (borrower — payable)
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'depositCollateral', outputs: [], stateMutability: 'payable', type: 'function' },
    // View
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'getCollateral', outputs: [{ internalType: 'uint128', name: '', type: 'uint128' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'getCollateralRatio', outputs: [{ internalType: 'uint256', name: 'ratio', type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ internalType: 'uint32', name: 'loanId', type: 'uint32' }], name: 'isAtRisk', outputs: [{ internalType: 'bool', name: 'warning', type: 'bool' }, { internalType: 'bool', name: 'liquidatable', type: 'bool' }], stateMutability: 'view', type: 'function' },
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

/**
 * BlockchainService
 * Core service for blockchain connectivity and contract management
 */
export class BlockchainService {
    private provider: JsonRpcProvider;
    private wallet: Wallet;

    // Contract instances (lazy loaded)
    private _avelonLending: Contract | null = null;
    private _collateralManager: Contract | null = null;
    private _repaymentSchedule: Contract | null = null;

    constructor() {
        // Use Sepolia RPC (production/testnet) with fallback to local
        const rpcUrl = process.env.SEPOLIA_RPC_URL || process.env.GANACHE_URL || 'http://127.0.0.1:8545';
        const privateKey = process.env.SEPOLIA_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;

        if (!privateKey) {
            console.warn('⚠️ No blockchain private key set (SEPOLIA_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY) - blockchain operations will fail');
        }

        this.provider = new ethers.JsonRpcProvider(rpcUrl);
        this.wallet = new ethers.Wallet(privateKey || '', this.provider);
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
    getSigner(): Wallet {
        return this.wallet;
    }

    /**
     * Get deployer/admin address
     */
    async getDeployerAddress(): Promise<string> {
        return this.wallet.getAddress();
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
    };

    /**
     * Get a contract instance backed by an inline ABI
     */
    getContract(contractName: string, address: string, useSigner = true): Contract {
        const abi = BlockchainService.CONTRACT_ABIS[contractName];
        if (!abi) {
            throw new Error(`Unknown contract: ${contractName}. Supported: ${Object.keys(BlockchainService.CONTRACT_ABIS).join(', ')}`);
        }
        const runner = useSigner ? this.wallet : this.provider;
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
        const tx = await this.wallet.sendTransaction({
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
        from?: string;
        to?: string;
        value?: string;
        gasUsed?: string;
    }> {
        try {
            const receipt = await this.provider.getTransactionReceipt(txHash);

            if (!receipt) {
                return { valid: false };
            }

            const tx = await this.provider.getTransaction(txHash);

            return {
                valid: receipt.status === 1,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to || undefined,
                value: tx ? ethers.formatEther(tx.value) : undefined,
                gasUsed: receipt.gasUsed.toString(),
            };
        } catch (error) {
            return { valid: false };
        }
    }

    /**
     * Verify wallet message signature
     */
    verifySignature(message: string, signature: string): string {
        return ethers.verifyMessage(message, signature);
    }
}

// Singleton instance
export const blockchainService = new BlockchainService();
