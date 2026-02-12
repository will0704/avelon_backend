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
    timestamp: string;
}

async function main() {
    // Get configuration from environment
    const rpcUrl = process.env.GANACHE_URL || "http://127.0.0.1:8545";
    const privateKey = process.env.DEPLOYER_PRIVATE_KEY;

    if (!privateKey) {
        throw new Error("DEPLOYER_PRIVATE_KEY environment variable is required");
    }

    console.log("Starting Avelon Smart Contracts Deployment...\n");

    // Connect to network
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const baseWallet = new ethers.Wallet(privateKey, provider);
    // Wrap wallet with NonceManager for proper nonce tracking across deployments
    const wallet = new ethers.NonceManager(baseWallet);
    const deployer = await baseWallet.getAddress();
    const network = await provider.getNetwork();

    console.log(`Network: ${network.name} (Chain ID: ${network.chainId})`);
    console.log(`Deployer: ${deployer}`);

    const balance = await provider.getBalance(deployer);
    console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

    if (balance === BigInt(0)) {
        throw new Error(
            "Deployer account has no ETH. Make sure you're using a private key from Ganache.\n" +
            "Run 'npx ganache --chain.chainId 1337' and copy a private key from the output."
        );
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
        network: network.name,
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
