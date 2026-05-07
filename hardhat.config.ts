import "@nomicfoundation/hardhat-chai-matchers";
import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import "solidity-coverage";

import { HardhatUserConfig, vars } from "hardhat/config";

const config: HardhatUserConfig = {
    solidity: {
        version: "0.8.27",
        settings: {
            evmVersion: "cancun",
            optimizer: { enabled: true, runs: 800 },
            metadata: { bytecodeHash: "none" },
        },
    },
    networks: {
        hardhat: {
            chainId: 31337,
            // The fhEVM library inflates compiled bytecode well beyond the 24KB
            // EIP-170 limit. Local testing relies on Hardhat ignoring the cap;
            // production deployments still hit it and require library extraction.
            allowUnlimitedContractSize: true,
        },
        sepolia: {
            url: "https://rpc.sepolia.zama.ai",
            chainId: 11155111,
            accounts: vars.has("PRIVATE_KEY") ? [vars.get("PRIVATE_KEY")] : [],
        },
    },
    typechain: {
        outDir: "types",
        target: "ethers-v6",
    },
    paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts",
    },
    gasReporter: {
        enabled: process.env.REPORT_GAS === "true",
    },
};

export default config;
