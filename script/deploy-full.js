/**
 * SCO Bond — Full Deployment & Settlement Script
 *
 * Deploys the entire ERC-3643 platform, creates a deal, whitelists investors,
 * mints bonds, funds investors with EURd, and executes atomic DVD swaps.
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in values
 *   2. npm install ethers@6
 *   3. node script/deploy-full.js
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

// Role wallets — for local testing these can all be the deployer
const REGISTRAR_KEY = process.env.REGISTRAR_PRIVATE_KEY || DEPLOYER_PRIVATE_KEY;
const BND_AGENT_KEY = process.env.BND_AGENT_PRIVATE_KEY || DEPLOYER_PRIVATE_KEY;
const INVESTOR1_KEY = process.env.INVESTOR1_PRIVATE_KEY;
const INVESTOR2_KEY = process.env.INVESTOR2_PRIVATE_KEY;

// Deal parameters
const TOKEN_NAME = process.env.TOKEN_NAME || "SCO Bond 51X5RT";
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || "SCO51X";
const SUPPLY_LIMIT = 5000; // max bonds
const BONDS_PER_INVESTOR = 2500; // split evenly between 2 investors
const CASH_PER_BOND = 1000000; // 1 EURd per bond (6 decimals, so 1 * 10^6)

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OUT = path.join(__dirname, "..", "out");

function loadArtifact(contractDir, contractName) {
  const filePath = path.join(OUT, contractDir, `${contractName}.json`);
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function deployContract(signer, artifact, args = [], label = "") {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  if (label) console.log(`  ${label}: ${addr}`);
  return contract;
}

function section(title) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Setup provider & signers ──
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const deployer = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);
  const registrar = new ethers.Wallet(REGISTRAR_KEY, provider);
  const bndAgent = new ethers.Wallet(BND_AGENT_KEY, provider);

  let investor1, investor2;
  if (INVESTOR1_KEY && INVESTOR2_KEY) {
    investor1 = new ethers.Wallet(INVESTOR1_KEY, provider);
    investor2 = new ethers.Wallet(INVESTOR2_KEY, provider);
  } else {
    // For local testing: generate random wallets and fund them
    investor1 = ethers.Wallet.createRandom().connect(provider);
    investor2 = ethers.Wallet.createRandom().connect(provider);
    console.log("Generated test investor wallets (will be funded by deployer)");
    const fundTx1 = await deployer.sendTransaction({
      to: investor1.address,
      value: ethers.parseEther("1"),
    });
    await fundTx1.wait();
    const fundTx2 = await deployer.sendTransaction({
      to: investor2.address,
      value: ethers.parseEther("1"),
    });
    await fundTx2.wait();
  }

  console.log("Deployer:   ", deployer.address);
  console.log("Registrar:  ", registrar.address);
  console.log("B&D Agent:  ", bndAgent.address);
  console.log("Investor 1: ", investor1.address);
  console.log("Investor 2: ", investor2.address);

  // ── Load artifacts ──
  const TokenArtifact = loadArtifact("Token.sol", "Token");
  const IRArtifact = loadArtifact("IdentityRegistry.sol", "IdentityRegistry");
  const IRSArtifact = loadArtifact("IdentityRegistryStorage.sol", "IdentityRegistryStorage");
  const CTRArtifact = loadArtifact("ClaimTopicsRegistry.sol", "ClaimTopicsRegistry");
  const TIRArtifact = loadArtifact("TrustedIssuersRegistry.sol", "TrustedIssuersRegistry");
  const MCArtifact = loadArtifact("ModularCompliance.sol", "ModularCompliance");
  const IAArtifact = loadArtifact("TREXImplementationAuthority.sol", "TREXImplementationAuthority");
  const FactoryArtifact = loadArtifact("TREXFactory.sol", "TREXFactory");
  const GatewayArtifact = loadArtifact("TREXGateway.sol", "TREXGateway");
  const SLMArtifact = loadArtifact("SupplyLimitModule.sol", "SupplyLimitModule");
  const ModuleProxyArtifact = loadArtifact("ModuleProxy.sol", "ModuleProxy");
  const CashArtifact = loadArtifact("MockCashToken.sol", "MockCashToken");
  const DVDArtifact = loadArtifact("DVDTransferManager.sol", "DVDTransferManager");

  // ══════════════════════════════════════════════════════════════════════════
  //  PHASE A: Platform Setup (Steps 1–12)
  // ══════════════════════════════════════════════════════════════════════════

  // ── Step 1: Deploy 6 implementation contracts ──
  section("Step 1: Deploy 6 Implementation Contracts (master copies)");

  const tokenImpl = await deployContract(deployer, TokenArtifact, [], "Token impl");
  const irImpl = await deployContract(deployer, IRArtifact, [], "IR impl");
  const irsImpl = await deployContract(deployer, IRSArtifact, [], "IRS impl");
  const ctrImpl = await deployContract(deployer, CTRArtifact, [], "CTR impl");
  const tirImpl = await deployContract(deployer, TIRArtifact, [], "TIR impl");
  const mcImpl = await deployContract(deployer, MCArtifact, [], "MC impl");

  // ── Step 2: Deploy TREXImplementationAuthority ──
  section("Step 2: Deploy ImplementationAuthority (IA)");

  const ia = await deployContract(
    deployer,
    IAArtifact,
    [
      true,                          // referenceStatus = true (main IA)
      ethers.ZeroAddress,            // trexFactory = 0x0 (set later)
      ethers.ZeroAddress,            // iaFactory = 0x0 (not needed for PoV)
    ],
    "IA"
  );

  // ── Step 3: Register implementations in the IA ──
  section("Step 3: Register implementations in IA (addAndUseTREXVersion)");

  const version = { major: 4, minor: 0, patch: 0 };
  const trexContracts = {
    tokenImplementation: await tokenImpl.getAddress(),
    ctrImplementation: await ctrImpl.getAddress(),
    irImplementation: await irImpl.getAddress(),
    irsImplementation: await irsImpl.getAddress(),
    tirImplementation: await tirImpl.getAddress(),
    mcImplementation: await mcImpl.getAddress(),
  };

  let tx = await ia.addAndUseTREXVersion(version, trexContracts);
  await tx.wait();
  console.log("  Version 4.0.0 registered and activated");

  // ── Step 4: Deploy TREXFactory ──
  section("Step 4: Deploy TREXFactory");

  const factory = await deployContract(
    deployer,
    FactoryArtifact,
    [await ia.getAddress()],         // implementationAuthority
    "Factory"
  );

  // ── Step 5: Link Factory back to IA ──
  section("Step 5: Link Factory to IA (ia.setTREXFactory)");

  tx = await ia.setTREXFactory(await factory.getAddress());
  await tx.wait();
  console.log("  IA now knows Factory address");

  // ── Step 6: Deploy TREXGateway ──
  section("Step 6: Deploy TREXGateway");

  const gateway = await deployContract(
    deployer,
    GatewayArtifact,
    [
      await factory.getAddress(),    // factory address
      false,                          // publicDeploymentStatus = false
    ],
    "Gateway"
  );

  // ── Step 7: Transfer Factory ownership to Gateway ──
  section("Step 7: Transfer Factory ownership to Gateway");

  tx = await factory.transferOwnership(await gateway.getAddress());
  await tx.wait();
  console.log("  Factory is now owned by Gateway");

  // ── Step 8: Add deployer as approved deployer on Gateway ──
  section("Step 8: Add deployer as approved deployer");

  tx = await gateway.addDeployer(deployer.address);
  await tx.wait();
  console.log(`  ${deployer.address} approved as deployer`);

  // ── Step 9: Deploy SupplyLimitModule ──
  section("Step 9: Deploy SupplyLimitModule");

  const slImpl = await deployContract(deployer, SLMArtifact, [], "SL impl");

  // ── Step 10: Deploy ModuleProxy for SupplyLimitModule ──
  section("Step 10: Deploy ModuleProxy for SupplyLimitModule");

  const initData = new ethers.Interface(SLMArtifact.abi).encodeFunctionData("initialize", []);
  const slProxy = await deployContract(
    deployer,
    ModuleProxyArtifact,
    [
      await slImpl.getAddress(),     // implementation
      initData,                       // _data = initialize()
    ],
    "SL proxy"
  );

  // ── Step 11: Deploy MockCashToken (EURd) ──
  section("Step 11: Deploy MockCashToken (EURd)");

  const cashToken = await deployContract(deployer, CashArtifact, [], "MockCashToken");

  // ── Step 12: Deploy DVDTransferManager ──
  section("Step 12: Deploy DVDTransferManager (atomic swap engine)");

  const dvd = await deployContract(deployer, DVDArtifact, [], "DVD Manager");

  // ══════════════════════════════════════════════════════════════════════════
  //  PHASE B: Create a Deal (Step 13)
  // ══════════════════════════════════════════════════════════════════════════

  section("Step 13: Deploy deal via gateway.deployTREXSuite()");

  const slProxyAddr = await slProxy.getAddress();

  // Build the compliance settings calldata: setSupplyLimit(5000)
  const slInterface = new ethers.Interface(SLMArtifact.abi);
  const complianceSettingsData = slInterface.encodeFunctionData("setSupplyLimit", [SUPPLY_LIMIT]);

  const tokenDetails = {
    owner: deployer.address,
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    decimals: 0,
    irs: ethers.ZeroAddress,
    ONCHAINID: ethers.ZeroAddress,
    irAgents: [registrar.address],
    tokenAgents: [bndAgent.address],
    complianceModules: [slProxyAddr],
    complianceSettings: [complianceSettingsData],
  };

  const claimDetails = {
    claimTopics: [],
    issuers: [],
    issuerClaims: [],
  };

  tx = await gateway.deployTREXSuite(tokenDetails, claimDetails);
  const receipt = await tx.wait();

  // Parse TREXSuiteDeployed event to get proxy addresses
  const factoryInterface = new ethers.Interface(FactoryArtifact.abi);
  let tokenProxy, irProxy, irsProxy, tirProxy, ctrProxy, mcProxy;

  for (const log of receipt.logs) {
    try {
      const parsed = factoryInterface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "TREXSuiteDeployed") {
        tokenProxy = parsed.args[0];
        irProxy = parsed.args[1];
        irsProxy = parsed.args[2];
        tirProxy = parsed.args[3];
        ctrProxy = parsed.args[4];
        mcProxy = parsed.args[5];
      }
    } catch (_) {
      // not our event
    }
  }

  console.log("  Deal deployed!");
  console.log(`  Token proxy: ${tokenProxy}`);
  console.log(`  IR proxy:    ${irProxy}`);
  console.log(`  IRS proxy:   ${irsProxy}`);
  console.log(`  TIR proxy:   ${tirProxy}`);
  console.log(`  CTR proxy:   ${ctrProxy}`);
  console.log(`  MC proxy:    ${mcProxy}`);

  // Get contract instances for the proxies
  const token = new ethers.Contract(tokenProxy, TokenArtifact.abi, deployer);
  const ir = new ethers.Contract(irProxy, IRArtifact.abi, deployer);

  // ══════════════════════════════════════════════════════════════════════════
  //  PHASE C: Run the Deal (Steps 14–21)
  // ══════════════════════════════════════════════════════════════════════════

  // ── Step 14: Whitelist investor wallets ──
  section("Step 14: Whitelist wallets (batchRegisterIdentity)");

  // Registrar is the IR agent — connect IR contract with registrar signer
  const irAsRegistrar = ir.connect(registrar);

  const walletsToWhitelist = [bndAgent.address, investor1.address, investor2.address];
  // identity = wallet itself (no ONCHAINID), country = 0
  const identities = walletsToWhitelist;
  const countries = [0, 0, 0];

  tx = await irAsRegistrar.batchRegisterIdentity(walletsToWhitelist, identities, countries);
  await tx.wait();
  console.log(`  Whitelisted ${walletsToWhitelist.length} addresses:`);
  console.log(`    B&D Agent:  ${bndAgent.address}`);
  console.log(`    Investor 1: ${investor1.address}`);
  console.log(`    Investor 2: ${investor2.address}`);

  // ── Step 15: Mint bonds to B&D agent ──
  section("Step 15: Mint bonds");

  const tokenAsBnd = token.connect(bndAgent);
  tx = await tokenAsBnd.mint(bndAgent.address, SUPPLY_LIMIT);
  await tx.wait();
  console.log(`  Minted ${SUPPLY_LIMIT} bonds to B&D agent (${bndAgent.address})`);

  // ── Step 16: Unpause the token ──
  section("Step 16: Unpause token");

  tx = await tokenAsBnd.unpause();
  await tx.wait();
  console.log("  Token unpaused — transfers now enabled");

  // ── Step 17: Mint test EURd to investors ──
  section("Step 17: Mint EURd cash to investors");

  const cashPerInvestor = BigInt(BONDS_PER_INVESTOR) * BigInt(CASH_PER_BOND);

  tx = await cashToken.mint(investor1.address, cashPerInvestor);
  await tx.wait();
  console.log(`  Investor 1: ${cashPerInvestor.toString()} EURd (${Number(cashPerInvestor) / 1e6} EUR)`);

  tx = await cashToken.mint(investor2.address, cashPerInvestor);
  await tx.wait();
  console.log(`  Investor 2: ${cashPerInvestor.toString()} EURd (${Number(cashPerInvestor) / 1e6} EUR)`);

  // ── Step 18: Investors approve DVDTransferManager to spend their EURd ──
  section("Step 18: Investors approve DVD contract for EURd");

  const dvdAddr = await dvd.getAddress();
  const cashAsInvestor1 = new ethers.Contract(await cashToken.getAddress(), CashArtifact.abi, investor1);
  const cashAsInvestor2 = new ethers.Contract(await cashToken.getAddress(), CashArtifact.abi, investor2);

  tx = await cashAsInvestor1.approve(dvdAddr, cashPerInvestor);
  await tx.wait();
  console.log(`  Investor 1 approved DVD for ${cashPerInvestor.toString()} EURd`);

  tx = await cashAsInvestor2.approve(dvdAddr, cashPerInvestor);
  await tx.wait();
  console.log(`  Investor 2 approved DVD for ${cashPerInvestor.toString()} EURd`);

  // ── Step 19: B&D agent approves DVDTransferManager to spend bonds ──
  section("Step 19: B&D agent approves DVD contract for bonds");

  const tokenAsBndForApproval = token.connect(bndAgent);
  tx = await tokenAsBndForApproval.approve(dvdAddr, SUPPLY_LIMIT);
  await tx.wait();
  console.log(`  B&D approved DVD for ${SUPPLY_LIMIT} bonds`);

  // ── Step 20: B&D agent initiates DVD transfers ──
  section("Step 20: B&D initiates DVD transfers (bond-for-cash offers)");

  const dvdAsBnd = dvd.connect(bndAgent);
  const tokenAddr = tokenProxy;
  const cashAddr = await cashToken.getAddress();

  // Initiate transfer for Investor 1
  tx = await dvdAsBnd.initiateDVDTransfer(
    tokenAddr,                     // _token1: bonds (what B&D offers)
    BONDS_PER_INVESTOR,            // _token1Amount: 2500 bonds
    investor1.address,             // _counterpart: investor 1
    cashAddr,                      // _token2: EURd (what investor pays)
    cashPerInvestor                // _token2Amount: 2500 * 10^6 EURd
  );
  let receipt1 = await tx.wait();

  // Parse DVDTransferInitiated event to get transferID
  const dvdInterface = new ethers.Interface(DVDArtifact.abi);
  let transferID1;
  for (const log of receipt1.logs) {
    try {
      const parsed = dvdInterface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "DVDTransferInitiated") {
        transferID1 = parsed.args[0]; // transferID is first indexed arg
      }
    } catch (_) {}
  }
  console.log(`  Transfer 1 initiated: ${transferID1}`);
  console.log(`    B&D offers ${BONDS_PER_INVESTOR} bonds → Investor 1`);
  console.log(`    Investor 1 pays ${Number(cashPerInvestor) / 1e6} EURd → B&D`);

  // Initiate transfer for Investor 2
  tx = await dvdAsBnd.initiateDVDTransfer(
    tokenAddr,
    BONDS_PER_INVESTOR,
    investor2.address,
    cashAddr,
    cashPerInvestor
  );
  let receipt2 = await tx.wait();

  let transferID2;
  for (const log of receipt2.logs) {
    try {
      const parsed = dvdInterface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "DVDTransferInitiated") {
        transferID2 = parsed.args[0];
      }
    } catch (_) {}
  }
  console.log(`  Transfer 2 initiated: ${transferID2}`);
  console.log(`    B&D offers ${BONDS_PER_INVESTOR} bonds → Investor 2`);
  console.log(`    Investor 2 pays ${Number(cashPerInvestor) / 1e6} EURd → B&D`);

  // ── Step 21: Investors execute DVD transfers (atomic swap!) ──
  section("Step 21: Investors execute atomic swaps (takeDVDTransfer)");

  // Investor 1 takes the swap
  const dvdAsInvestor1 = dvd.connect(investor1);
  tx = await dvdAsInvestor1.takeDVDTransfer(transferID1);
  await tx.wait();
  console.log("  Investor 1 swap EXECUTED!");

  // Investor 2 takes the swap
  const dvdAsInvestor2 = dvd.connect(investor2);
  tx = await dvdAsInvestor2.takeDVDTransfer(transferID2);
  await tx.wait();
  console.log("  Investor 2 swap EXECUTED!");

  // ══════════════════════════════════════════════════════════════════════════
  //  Verify final state
  // ══════════════════════════════════════════════════════════════════════════

  section("Final State — Verify Balances");

  const bndBondBal = await token.balanceOf(bndAgent.address);
  const inv1BondBal = await token.balanceOf(investor1.address);
  const inv2BondBal = await token.balanceOf(investor2.address);

  const bndCashBal = await cashToken.balanceOf(bndAgent.address);
  const inv1CashBal = await cashToken.balanceOf(investor1.address);
  const inv2CashBal = await cashToken.balanceOf(investor2.address);

  console.log("  Bond balances:");
  console.log(`    B&D Agent:  ${bndBondBal.toString()} bonds`);
  console.log(`    Investor 1: ${inv1BondBal.toString()} bonds`);
  console.log(`    Investor 2: ${inv2BondBal.toString()} bonds`);
  console.log("");
  console.log("  EURd balances:");
  console.log(`    B&D Agent:  ${bndCashBal.toString()} (${Number(bndCashBal) / 1e6} EUR)`);
  console.log(`    Investor 1: ${inv1CashBal.toString()} (${Number(inv1CashBal) / 1e6} EUR)`);
  console.log(`    Investor 2: ${inv2CashBal.toString()} (${Number(inv2CashBal) / 1e6} EUR)`);

  // ══════════════════════════════════════════════════════════════════════════
  //  Print all addresses for .env
  // ══════════════════════════════════════════════════════════════════════════

  section("All Deployed Addresses (save to .env)");

  console.log(`IA=${await ia.getAddress()}`);
  console.log(`FACTORY=${await factory.getAddress()}`);
  console.log(`GATEWAY=${await gateway.getAddress()}`);
  console.log(`SUPPLY_LIMIT_MODULE=${slProxyAddr}`);
  console.log(`MOCK_CASH_TOKEN=${await cashToken.getAddress()}`);
  console.log(`DVD_MANAGER=${dvdAddr}`);
  console.log(`TOKEN_PROXY=${tokenProxy}`);
  console.log(`IR_PROXY=${irProxy}`);
  console.log(`IRS_PROXY=${irsProxy}`);
  console.log(`TIR_PROXY=${tirProxy}`);
  console.log(`CTR_PROXY=${ctrProxy}`);
  console.log(`MC_PROXY=${mcProxy}`);

  console.log("\nDone! All steps completed successfully.");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
