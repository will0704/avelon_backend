import { ethers, Contract, JsonRpcProvider, Wallet, ContractTransactionResponse } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * BlockchainService
 * Core service for blockchain connectivity and contract management
 */
export class BlockchainService {
    private provider: JsonRpcProvider;
    private wallet: Wallet;
    private contractsPath: string;

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
        this.contractsPath = path.join(__dirname, '..', '..', 'contracts', 'artifacts', 'contracts');
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
     * Check if an address is valid
     */
    isValidAddress(address: string): boolean {
        return ethers.isAddress(address);
    }

    /**
     * Get current block number
     */
    async getBlockNumber(): Promise<number> {
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

    /**
     * Load contract ABI from artifacts
     */
    private loadContractABI(contractName: string): { abi: any; bytecode: string } {
        const artifactPath = path.join(
            this.contractsPath,
            `${contractName}.sol`,
            `${contractName}.json`
        );

        if (!fs.existsSync(artifactPath)) {
            throw new Error(`Contract artifact not found: ${artifactPath}. Run 'npm run compile' in contracts folder.`);
        }

        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
        return {
            abi: artifact.abi,
            bytecode: artifact.bytecode,
        };
    }

    /**
     * Get a contract instance
     */
    getContract(contractName: string, address: string, useSigner = true): Contract {
        const { abi } = this.loadContractABI(contractName);
        const runner = useSigner ? this.wallet : this.provider;
        return new ethers.Contract(address, abi, runner);
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
