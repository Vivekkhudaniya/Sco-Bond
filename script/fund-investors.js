const { ethers } = require("ethers");
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const RPC_URL = process.env.RPC_URL || "https://rpc.sepolia.org";
const ADMIN_KEY = process.env.ADMIN_PRIVATE_KEY;
const INVESTOR1 = process.env.INVESTOR1_ADDRESS;
const INVESTOR2 = process.env.INVESTOR2_ADDRESS;

const AMOUNT = ethers.parseEther("0.05"); // 0.05 ETH each — enough for gas

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const admin = new ethers.Wallet(ADMIN_KEY, provider);

  const network = await provider.getNetwork();
  console.log(`Network: ${network.name} (chainId ${network.chainId})`);

  const adminBalance = await provider.getBalance(admin.address);
  console.log(`Admin  ${admin.address}`);
  console.log(`Balance: ${ethers.formatEther(adminBalance)} ETH\n`);

  const totalNeeded = AMOUNT * 2n;
  if (adminBalance < totalNeeded) {
    console.error(`Need at least ${ethers.formatEther(totalNeeded)} ETH, have ${ethers.formatEther(adminBalance)}`);
    process.exit(1);
  }

  for (const [label, to] of [["Investor 1", INVESTOR1], ["Investor 2", INVESTOR2]]) {
    const balanceBefore = await provider.getBalance(to);
    console.log(`${label} ${to}`);
    console.log(`  Before: ${ethers.formatEther(balanceBefore)} ETH`);

    const tx = await admin.sendTransaction({ to, value: AMOUNT });
    console.log(`  Tx:     ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  Status: ${receipt.status === 1 ? "confirmed" : "FAILED"} (block ${receipt.blockNumber})`);

    const balanceAfter = await provider.getBalance(to);
    console.log(`  After:  ${ethers.formatEther(balanceAfter)} ETH\n`);
  }

  const adminFinal = await provider.getBalance(admin.address);
  console.log(`Admin remaining: ${ethers.formatEther(adminFinal)} ETH`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
