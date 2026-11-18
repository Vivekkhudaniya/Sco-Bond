import { network, artifacts } from "hardhat";
import { ethers } from "ethers";

export async function setupProvider() {
  const conn = await network.getOrCreate();
  const provider = new ethers.BrowserProvider(conn.provider);
  return { conn, provider };
}

export async function getSigners(provider) {
  const accounts = await provider.listAccounts();
  return {
    deployer: accounts[0],
    platformAdmin: accounts[1],
    registrar: accounts[2],
    bndSafe: accounts[3],
    aurora: accounts[4],
    northbridge: accounts[5],
    meridian: accounts[6],
    outsider: accounts[7],
  };
}

export async function deployContract(signer, artifactName, ...args) {
  const artifact = await artifacts.readArtifact(artifactName);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

export async function getContractAt(artifactName, address, signer) {
  const artifact = await artifacts.readArtifact(artifactName);
  return new ethers.Contract(address, artifact.abi, signer);
}

export const SUPPLY_LIMIT = 5000n;

export function findEvent(receipt, contract, eventName) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === eventName) return parsed;
    } catch {}
  }
  return null;
}

export function randomAddress() {
  return ethers.Wallet.createRandom().address;
}

export function randomCountry() {
  return Math.floor(Math.random() * 999) + 1;
}

export async function deployPlatform(deployer) {
  // Step 1: deploy 6 implementations
  const tokenImpl = await deployContract(deployer, "Token");
  const irImpl = await deployContract(deployer, "IdentityRegistry");
  const irsImpl = await deployContract(deployer, "IdentityRegistryStorage");
  const ctrImpl = await deployContract(deployer, "ClaimTopicsRegistry");
  const tirImpl = await deployContract(deployer, "TrustedIssuersRegistry");
  const mcImpl = await deployContract(deployer, "ModularCompliance");

  // Step 2: deploy IA + register version
  const ia = await deployContract(
    deployer,
    "TREXImplementationAuthority",
    true,
    ethers.ZeroAddress,
    ethers.ZeroAddress
  );

  const impls = {
    tokenImplementation: await tokenImpl.getAddress(),
    ctrImplementation: await ctrImpl.getAddress(),
    irImplementation: await irImpl.getAddress(),
    irsImplementation: await irsImpl.getAddress(),
    tirImplementation: await tirImpl.getAddress(),
    mcImplementation: await mcImpl.getAddress(),
  };

  const version = { major: 1, minor: 0, patch: 0 };
  await ia.addAndUseTREXVersion(version, impls);

  // Step 3: deploy factory
  const factory = await deployContract(deployer, "TREXFactory", await ia.getAddress());

  // Step 4: deploy gateway, wire ownership, add deployer
  const gateway = await deployContract(
    deployer,
    "TREXGateway",
    await factory.getAddress(),
    false
  );
  await factory.transferOwnership(await gateway.getAddress());
  await gateway.addDeployer(deployer.address);

  // Step 5: deploy SupplyLimitModule behind proxy
  const slImpl = await deployContract(deployer, "SupplyLimitModule");
  const slProxy = await deployContract(
    deployer,
    "ModuleProxy",
    await slImpl.getAddress(),
    "0x"
  );
  const supplyLimitModule = await getContractAt(
    "SupplyLimitModule",
    await slProxy.getAddress(),
    deployer
  );
  await supplyLimitModule.initialize();

  // Step 6: deploy cash + DVD
  const cashToken = await deployContract(deployer, "MockCashToken");
  const dvdManager = await deployContract(deployer, "DVDTransferManager");

  return {
    ia,
    factory,
    gateway,
    supplyLimitModule,
    cashToken,
    dvdManager,
  };
}

export function defaultTokenDetails(platformAdminAddress, registrarAddress, bndSafeAddress, supplyLimitModuleAddress) {
  const iface = new ethers.Interface([
    "function setSupplyLimit(uint256)",
  ]);
  const complianceSettings = iface.encodeFunctionData("setSupplyLimit", [
    SUPPLY_LIMIT,
  ]);

  return {
    owner: platformAdminAddress,
    name: "ACME Corp / 3.875% Fixed EMTN",
    symbol: "TR-51X5RT-01",
    decimals: 0,
    irs: ethers.ZeroAddress,
    ONCHAINID: ethers.ZeroAddress,
    irAgents: [registrarAddress],
    tokenAgents: [bndSafeAddress],
    complianceModules: [supplyLimitModuleAddress],
    complianceSettings: [complianceSettings],
  };
}

export function defaultClaimDetails() {
  return {
    claimTopics: [],
    issuers: [],
    issuerClaims: [],
  };
}

export async function deployDeal(gateway, deployer, platformAdmin, registrar, bndSafe, supplyLimitModule) {
  const slAddress = await supplyLimitModule.getAddress();

  const slAbi = supplyLimitModule.interface;
  const complianceSettings = slAbi.encodeFunctionData("setSupplyLimit", [
    SUPPLY_LIMIT,
  ]);

  const tokenDetails = {
    owner: platformAdmin.address,
    name: "ACME Corp / 3.875% Fixed EMTN",
    symbol: "TR-51X5RT-01",
    decimals: 0,
    irs: ethers.ZeroAddress,
    ONCHAINID: ethers.ZeroAddress,
    irAgents: [registrar.address],
    tokenAgents: [bndSafe.address],
    complianceModules: [slAddress],
    complianceSettings: [complianceSettings],
  };

  const claimDetails = {
    claimTopics: [],
    issuers: [],
    issuerClaims: [],
  };

  const tx = await gateway.deployTREXSuite(tokenDetails, claimDetails);
  const receipt = await tx.wait();

  // Parse TREXSuiteDeployed event from factory
  const factoryArtifact = await artifacts.readArtifact("TREXFactory");
  const factoryIface = new ethers.Interface(factoryArtifact.abi);

  let dealAddresses = {};
  for (const log of receipt.logs) {
    try {
      const parsed = factoryIface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "TREXSuiteDeployed") {
        dealAddresses = {
          token: parsed.args[0],
          ir: parsed.args[1],
          irs: parsed.args[2],
          tir: parsed.args[3],
          ctr: parsed.args[4],
          mc: parsed.args[5],
        };
        break;
      }
    } catch {
      // not this event, skip
    }
  }

  if (!dealAddresses.token) {
    throw new Error("TREXSuiteDeployed event not found");
  }

  return dealAddresses;
}
