import { configVariable, HardhatUserConfig } from "hardhat/config";

const config: HardhatUserConfig = {
    paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts",
    },
    solidity: {
        version: "0.8.28",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
            evmVersion: "cancun",
        },
    },
    networks: {
        // Local Hardhat network for testing
        hardhat: {
            type: "edr-simulated",
            chainType: "l1",
        },
        // Ganache local development
        ganache: {
            type: "http",
            chainType: "l1",
            url: configVariable("GANACHE_URL"),
            accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
        },
        // Sepolia testnet
        sepolia: {
            type: "http",
            chainType: "l1",
            url: configVariable("SEPOLIA_RPC_URL"),
            accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
        },
    },
    test: {
        solidity: {
            timeout: 60000,
        },
    },
};

export default config;
