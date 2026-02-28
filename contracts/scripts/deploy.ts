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
    deployer: string;
    network: string;
    chainId: number;
    timestamp: string;
}

type NetworkName = "ganache" | "sepolia" | "hardhat";

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
                    rpcUrl: "http://127.0.0.1:8545",
                    privateKey: process.env.DEPLOYER_PRIVATE_KEY || "",
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

    if (balance === BigInt(0)) {
        throw new Error(
            `Deployer account has no ETH on ${networkName}.\n` +
            (networkName === "sepolia"
                ? "Get free Sepolia ETH from: https://cloud.google.com/application/web3/faucet/ethereum/sepolia"
                : "Run 'npx ganache --chain.chainId 1337' and copy a private key from the output.")
        );
    }

    const minBalance = networkName === "sepolia" ? ethers.parseEther("0.01") : BigInt(0);
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

    // Link contracts
    console.log("\nLinking contracts...");

    // Set CollateralManager's lending contract reference
    const cmContract = new ethers.Contract(
        collateralManagerAddress,
        collateralManagerArtifact.abi,
        wallet
    );
    const tx1 = await cmContract.setLendingContract(avelonLendingAddress);
    await tx1.wait();
    console.log("  [OK] CollateralManager -> AvelonLending linked");

    // Set AvelonLending's collateral manager reference
    const alContract = new ethers.Contract(
        avelonLendingAddress,
        avelonLendingArtifact.abi,
        wallet
    );
    const tx2 = await alContract.setCollateralManager(collateralManagerAddress);
    await tx2.wait();
    console.log("  [OK] AvelonLending -> CollateralManager linked");

    // Save deployment info
    const deploymentInfo: DeployedContracts = {
        avelonLending: avelonLendingAddress,
        collateralManager: collateralManagerAddress,
        repaymentSchedule: repaymentScheduleAddress,
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

    return deploymentInfo;
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Deployment failed:", error.message || error);
        process.exit(1);
    });
