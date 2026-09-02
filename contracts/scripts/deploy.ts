import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from parent directory (avelon_backend)
config({ path: path.join(__dirname, "..", "..", ".env") });

interface DeployedContracts {
    avelonLending: string;
    collateralManager: string;
    repaymentSchedule: string;
    liquidityPool: string;
    deployer: string;
    network: string;
    chainId: number;
    timestamp: string;
}

type NetworkName = "ganache" | "sepolia" | "baseSepolia" | "hardhat";

interface NetworkConfig {
    rpcUrl: string;
    privateKey: string;
    expectedChainId?: number;
}

function getNetworkConfig(): { network: NetworkName; config: NetworkConfig } {
    // Detect network from CLI args: --network sepolia
    const networkArg = process.argv.find((_, i, arr) => arr[i - 1] === "--network");
    const network = (networkArg || process.env.DEPLOY_NETWORK || "ganache") as NetworkName;

    switch (network) {
        case "baseSepolia": {
            const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
            // Same EOA works on both chains, so fall back to the Sepolia key
            const privateKey = process.env.BASE_SEPOLIA_PRIVATE_KEY || process.env.SEPOLIA_PRIVATE_KEY;
            if (!rpcUrl) throw new Error("BASE_SEPOLIA_RPC_URL is required for Base Sepolia deployment");
            if (!privateKey) throw new Error("BASE_SEPOLIA_PRIVATE_KEY or SEPOLIA_PRIVATE_KEY is required");
            return {
                network,
                config: { rpcUrl, privateKey, expectedChainId: 84532 },
            };
        }
        case "sepolia": {
            const rpcUrl = process.env.SEPOLIA_RPC_URL;
            const privateKey = process.env.SEPOLIA_PRIVATE_KEY;
            if (!rpcUrl) throw new Error("SEPOLIA_RPC_URL is required for Sepolia deployment");
            if (!privateKey) throw new Error("SEPOLIA_PRIVATE_KEY is required for Sepolia deployment");
            return {
                network,
                config: { rpcUrl, privateKey, expectedChainId: 11155111 },
            };
        }
        case "hardhat":
            return {
                network,
                config: {
                    rpcUrl: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
                    // Hardhat's node prints the same account #0 on every machine. It is
                    // a published test key and must never be used off localhost.
                    privateKey:
                        process.env.DEPLOYER_PRIVATE_KEY ||
                        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
                    expectedChainId: 31337,
                },
            };
        case "ganache":
        default: {
            const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
            if (!privateKey) throw new Error("DEPLOYER_PRIVATE_KEY is required");
            return {
                network,
                config: {
                    rpcUrl: process.env.GANACHE_URL || "http://127.0.0.1:8545",
                    privateKey,
                    expectedChainId: 1337,
                },
            };
        }
    }
}

/**
 * Wait until the RPC actually reports code at an address.
 *
 * A deployment receipt is not enough: providers load-balance across nodes, and a
 * node that has not seen the deployment yet estimates a call to that address as if
 * it were an empty account (~22k). The link tx then goes out with a gas limit far
 * below the ~30k it needs and reverts out of gas.
 */
async function waitForCode(
    provider: ethers.JsonRpcProvider,
    address: string,
    label: string,
    attempts = 30
): Promise<void> {
    for (let i = 0; i < attempts; i++) {
        const code = await provider.getCode(address);
        if (code && code !== "0x") return;
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`${label} has no code at ${address} after ${attempts * 2}s — RPC never caught up`);
}

/**
 * Poll an address-returning getter until it reports the expected value.
 *
 * Same lag as waitForCode, on the read side: a mined link tx can still read back
 * as the zero address from a node that has not caught up yet.
 */
async function waitForLink(
    read: () => Promise<string>,
    expected: string,
    label: string,
    attempts = 20
): Promise<void> {
    let last = "";
    for (let i = 0; i < attempts; i++) {
        last = await read();
        if (last.toLowerCase() === expected.toLowerCase()) return;
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`${label} is ${last}, expected ${expected} after ${attempts * 2}s`);
}

async function main() {
    // Get network configuration
    const { network: networkName, config: netConfig } = getNetworkConfig();
    const { rpcUrl, privateKey } = netConfig;

    if (!privateKey) {
        throw new Error("Private key is required for deployment");
    }

    console.log(`Starting Avelon Smart Contracts Deployment on ${networkName.toUpperCase()}...\n`);

    // Connect to network
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const baseWallet = new ethers.Wallet(privateKey, provider);
    // Wrap wallet with NonceManager for proper nonce tracking across deployments
    const wallet = new ethers.NonceManager(baseWallet);
    const deployer = await baseWallet.getAddress();
    const network = await provider.getNetwork();

    // Validate chain ID if expected
    if (netConfig.expectedChainId && Number(network.chainId) !== netConfig.expectedChainId) {
        throw new Error(
            `Chain ID mismatch! Expected ${netConfig.expectedChainId} for ${networkName}, ` +
            `got ${network.chainId}. Check your RPC URL.`
        );
    }

    console.log(`Network: ${networkName} (Chain ID: ${network.chainId})`);
    console.log(`Deployer: ${deployer}`);

    const balance = await provider.getBalance(deployer);
    console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

    const FAUCETS: Record<string, string> = {
        sepolia: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
        baseSepolia: "https://portal.cdp.coinbase.com/products/faucet",
    };

    if (balance === BigInt(0)) {
        throw new Error(
            `Deployer account has no ETH on ${networkName}.\n` +
            (FAUCETS[networkName]
                ? `Get free testnet ETH from: ${FAUCETS[networkName]}`
                : "Run 'npx ganache --chain.chainId 1337' and copy a private key from the output.")
        );
    }

    // L2 gas is far cheaper, but the deploy still has to clear three contracts
    const minBalance = FAUCETS[networkName] ? ethers.parseEther("0.01") : BigInt(0);
    if (balance < minBalance) {
        console.warn(`⚠ WARNING: Low balance (${ethers.formatEther(balance)} ETH). Deployment may fail due to gas costs.`);
    }

    // Load contract artifacts
    const artifactsPath = path.join(__dirname, "..", "artifacts", "contracts");

    const loadArtifact = (contractName: string) => {
        const artifactPath = path.join(artifactsPath, `${contractName}.sol`, `${contractName}.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
        return artifact;
    };

    // Use deployer as treasury unless a valid address is provided
    const envTreasury = process.env.TREASURY_ADDRESS;
    const treasuryAddress = (envTreasury && /^0x[a-fA-F0-9]{40}$/.test(envTreasury))
        ? envTreasury
        : deployer;
    console.log(`Treasury: ${treasuryAddress}\n`);

    // Deploy AvelonLending
    console.log("Deploying AvelonLending...");
    const avelonLendingArtifact = loadArtifact("AvelonLending");
    const AvelonLendingFactory = new ethers.ContractFactory(
        avelonLendingArtifact.abi,
        avelonLendingArtifact.bytecode,
        wallet
    );
    const avelonLending = await AvelonLendingFactory.deploy(treasuryAddress);
    const avelonLendingTx = avelonLending.deploymentTransaction();
    if (!avelonLendingTx) throw new Error("Failed to get deployment transaction for AvelonLending");
    const avelonLendingReceipt = await avelonLendingTx.wait();
    if (!avelonLendingReceipt?.contractAddress) throw new Error("AvelonLending deployment receipt missing contractAddress");
    const avelonLendingAddress = avelonLendingReceipt.contractAddress;
    console.log(`  [OK] AvelonLending deployed at: ${avelonLendingAddress}`);

    // Deploy CollateralManager
    console.log("Deploying CollateralManager...");
    const collateralManagerArtifact = loadArtifact("CollateralManager");
    const CollateralManagerFactory = new ethers.ContractFactory(
        collateralManagerArtifact.abi,
        collateralManagerArtifact.bytecode,
        wallet
    );
    const collateralManager = await CollateralManagerFactory.deploy();
    const collateralManagerTx = collateralManager.deploymentTransaction();
    if (!collateralManagerTx) throw new Error("Failed to get deployment transaction for CollateralManager");
    const collateralManagerReceipt = await collateralManagerTx.wait();
    if (!collateralManagerReceipt?.contractAddress) throw new Error("CollateralManager deployment receipt missing contractAddress");
    const collateralManagerAddress = collateralManagerReceipt.contractAddress;
    console.log(`  [OK] CollateralManager deployed at: ${collateralManagerAddress}`);

    // Verify addresses are unique (sanity check)
    if (avelonLendingAddress === collateralManagerAddress) {
        throw new Error("Deployment error: AvelonLending and CollateralManager have same address");
    }

    // Deploy RepaymentSchedule
    console.log("Deploying RepaymentSchedule...");
    const repaymentScheduleArtifact = loadArtifact("RepaymentSchedule");
    const RepaymentScheduleFactory = new ethers.ContractFactory(
        repaymentScheduleArtifact.abi,
        repaymentScheduleArtifact.bytecode,
        wallet
    );
    const repaymentSchedule = await RepaymentScheduleFactory.deploy();
    const repaymentScheduleTx = repaymentSchedule.deploymentTransaction();
    if (!repaymentScheduleTx) throw new Error("Failed to get deployment transaction for RepaymentSchedule");
    const repaymentScheduleReceipt = await repaymentScheduleTx.wait();
    if (!repaymentScheduleReceipt?.contractAddress) throw new Error("RepaymentSchedule deployment receipt missing contractAddress");
    const repaymentScheduleAddress = repaymentScheduleReceipt.contractAddress;
    console.log(`  [OK] RepaymentSchedule deployed at: ${repaymentScheduleAddress}`);

    // Deploy AvelonLiquidityPool
    console.log("Deploying AvelonLiquidityPool...");
    const liquidityPoolArtifact = loadArtifact("AvelonLiquidityPool");
    const LiquidityPoolFactory = new ethers.ContractFactory(
        liquidityPoolArtifact.abi,
        liquidityPoolArtifact.bytecode,
        wallet
    );
    const liquidityPool = await LiquidityPoolFactory.deploy();
    const liquidityPoolTx = liquidityPool.deploymentTransaction();
    if (!liquidityPoolTx) throw new Error("Failed to get deployment transaction for AvelonLiquidityPool");
    const liquidityPoolReceipt = await liquidityPoolTx.wait();
    if (!liquidityPoolReceipt?.contractAddress) throw new Error("AvelonLiquidityPool deployment receipt missing contractAddress");
    const liquidityPoolAddress = liquidityPoolReceipt.contractAddress;
    console.log(`  [OK] AvelonLiquidityPool deployed at: ${liquidityPoolAddress}`);

    // Link contracts
    console.log("\nLinking contracts...");

    // Both addresses must be visible to the RPC before any gas estimate is made
    await waitForCode(provider, avelonLendingAddress, "AvelonLending");
    await waitForCode(provider, collateralManagerAddress, "CollateralManager");

    // Set CollateralManager's lending contract reference
    const cmContract = new ethers.Contract(
        collateralManagerAddress,
        collateralManagerArtifact.abi,
        wallet
    );
    const tx1 = await cmContract.setLendingContract(avelonLendingAddress);
    const rcpt1 = await tx1.wait();
    if (rcpt1?.status !== 1) throw new Error("setLendingContract reverted");
    console.log("  [OK] CollateralManager -> AvelonLending linked");

    // Set AvelonLending's collateral manager reference
    const alContract = new ethers.Contract(
        avelonLendingAddress,
        avelonLendingArtifact.abi,
        wallet
    );
    const tx2 = await alContract.setCollateralManager(collateralManagerAddress);
    const rcpt2 = await tx2.wait();
    if (rcpt2?.status !== 1) throw new Error("setCollateralManager reverted");
    console.log("  [OK] AvelonLending -> CollateralManager linked");

    // Read the links back. A mined tx is not proof the state changed, and an
    // unlinked pair fails later at the first collateral deposit, not here.
    await waitForLink(
        () => cmContract.lendingContract(),
        avelonLendingAddress,
        "CollateralManager.lendingContract"
    );
    await waitForLink(
        () => alContract.collateralManager(),
        collateralManagerAddress,
        "AvelonLending.collateralManager"
    );
    console.log("  [OK] Links verified on-chain");

    // Save deployment info
    const deploymentInfo: DeployedContracts = {
        avelonLending: avelonLendingAddress,
        collateralManager: collateralManagerAddress,
        repaymentSchedule: repaymentScheduleAddress,
        liquidityPool: liquidityPoolAddress,
        deployer,
        network: networkName,
        chainId: Number(network.chainId),
        timestamp: new Date().toISOString(),
    };

    const deploymentsDir = path.join(__dirname, "..", "deployments");
    if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const deploymentFile = path.join(deploymentsDir, `${network.chainId}.json`);
    fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
    console.log(`\nDeployment info saved to: ${deploymentFile}`);

    console.log("\nDeployment complete!");
    console.log("\nContract Addresses (add these to .env):");
    console.log(`AVELON_LENDING_ADDRESS=${avelonLendingAddress}`);
    console.log(`COLLATERAL_MANAGER_ADDRESS=${collateralManagerAddress}`);
    console.log(`REPAYMENT_SCHEDULE_ADDRESS=${repaymentScheduleAddress}`);
    console.log(`LIQUIDITY_POOL_ADDRESS=${liquidityPoolAddress}`);

    return deploymentInfo;
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Deployment failed:", error.message || error);
        process.exit(1);
    });
