import "dotenv/config";
import HardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";

export default {
  plugins: [HardhatNodeTestRunner],
  solidity: {
    version: "0.8.17",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "london",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test-hardhat",
    cache: "./cache-hardhat",
    artifacts: "./artifacts",
  },
};
