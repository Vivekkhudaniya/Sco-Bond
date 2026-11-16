import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { network, artifacts } from "hardhat";
import { ethers } from "ethers";
import {
  setupProvider,
  getSigners,
  deployPlatform,
  deployDeal,
  getContractAt,
  SUPPLY_LIMIT,
} from "./helpers.js";

describe("Phase 1: Factory & Gateway", () => {
  let conn, provider;
  let deployer, platformAdmin, registrar, bndSafe, outsider;
  let ia, factory, gateway, supplyLimitModule, cashToken, dvdManager;
  let deal; // { token, ir, irs, tir, ctr, mc }

  before(async () => {
    ({ conn, provider } = await setupProvider());
    const signers = await getSigners(provider);
    deployer = signers.deployer;
    platformAdmin = signers.platformAdmin;
    registrar = signers.registrar;
    bndSafe = signers.bndSafe;
    outsider = signers.outsider;

    ({ ia, factory, gateway, supplyLimitModule, cashToken, dvdManager } =
      await deployPlatform(deployer));

    deal = await deployDeal(
      gateway,
      deployer,
      platformAdmin,
      registrar,
      bndSafe,
      supplyLimitModule
    );
  });

  after(async () => {
    if (conn) await conn.close();
  });

  // ═══════════════════════════════════════════════════════════════════
  //  1.1 TREXFactory — deployTREXSuite
  // ═══════════════════════════════════════════════════════════════════

  it("deploys 6 non-zero proxy addresses", async () => {
    assert.notEqual(deal.token, ethers.ZeroAddress, "token is zero");
    assert.notEqual(deal.ir, ethers.ZeroAddress, "ir is zero");
    assert.notEqual(deal.irs, ethers.ZeroAddress, "irs is zero");
    assert.notEqual(deal.tir, ethers.ZeroAddress, "tir is zero");
    assert.notEqual(deal.ctr, ethers.ZeroAddress, "ctr is zero");
    assert.notEqual(deal.mc, ethers.ZeroAddress, "mc is zero");
  });

  it("deploys 6 unique proxy addresses", async () => {
    const addrs = [deal.token, deal.ir, deal.irs, deal.tir, deal.ctr, deal.mc];
    const unique = new Set(addrs);
    assert.equal(unique.size, 6, "proxy addresses are not all unique");
  });

  it("sets ownership to platformAdmin", async () => {
    for (const [name, addr] of [
      ["token", deal.token],
      ["ir", deal.ir],
      ["tir", deal.tir],
      ["ctr", deal.ctr],
      ["mc", deal.mc],
    ]) {
      const contract = await getContractAt("Token", addr, deployer);
      const owner = await contract.owner();
      assert.equal(owner, platformAdmin.address, `${name} owner mismatch`);
    }
  });

  it("registers registrar as IR agent", async () => {
    const ir = await getContractAt("AgentRole", deal.ir, deployer);
    const isAgent = await ir.isAgent(registrar.address);
    assert.equal(isAgent, true, "registrar not IR agent");
  });

  it("registers bndSafe as Token agent", async () => {
    const token = await getContractAt("AgentRole", deal.token, deployer);
    const isAgent = await token.isAgent(bndSafe.address);
    assert.equal(isAgent, true, "bndSafe not token agent");
  });

  it("binds SupplyLimitModule to compliance", async () => {
    const mc = await getContractAt("ModularCompliance", deal.mc, deployer);
    const isBound = await mc.isModuleBound(await supplyLimitModule.getAddress());
    assert.equal(isBound, true, "supply limit module not bound");
  });

  it("sets supply limit to 5000", async () => {
    const limit = await supplyLimitModule.getSupplyLimit(deal.mc);
    assert.equal(limit, SUPPLY_LIMIT, "supply limit mismatch");
  });

  it("binds IRS to IR", async () => {
    const irs = await getContractAt("IdentityRegistryStorage", deal.irs, deployer);
    const linked = await irs.linkedIdentityRegistries();
    const found = linked.some(
      (addr) => addr.toLowerCase() === deal.ir.toLowerCase()
    );
    assert.equal(found, true, "IRS not linked to IR");
  });

  it("registers Token as IR agent", async () => {
    const ir = await getContractAt("AgentRole", deal.ir, deployer);
    const isAgent = await ir.isAgent(deal.token);
    assert.equal(isAgent, true, "Token not registered as IR agent");
  });

  it("sets onchainID to zero", async () => {
    const token = await getContractAt("Token", deal.token, deployer);
    const oid = await token.onchainID();
    assert.equal(oid, ethers.ZeroAddress, "onchainID should be zero");
  });

  it("deploys with empty claim topics", async () => {
    const ctr = await getContractAt("ClaimTopicsRegistry", deal.ctr, deployer);
    const topics = await ctr.getClaimTopics();
    assert.equal(topics.length, 0, "claim topics should be empty");
  });

  it("deploys with empty trusted issuers", async () => {
    const tir = await getContractAt("TrustedIssuersRegistry", deal.tir, deployer);
    const issuers = await tir.getTrustedIssuers();
    assert.equal(issuers.length, 0, "trusted issuers should be empty");
  });

  it("token starts paused", async () => {
    const token = await getContractAt("Token", deal.token, deployer);
    const paused = await token.paused();
    assert.equal(paused, true, "token should start paused");
  });

  it("token has correct metadata", async () => {
    const token = await getContractAt("Token", deal.token, deployer);
    assert.equal(await token.name(), "ACME Corp / 3.875% Fixed EMTN");
    assert.equal(await token.symbol(), "TR-51X5RT-01");
    assert.equal(await token.decimals(), 0n);
  });

  it("duplicate salt reverts", async () => {
    await assert.rejects(
      async () => {
        await deployDeal(
          gateway,
          deployer,
          platformAdmin,
          registrar,
          bndSafe,
          supplyLimitModule
        );
      },
      "should revert on duplicate salt"
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  //  1.2 TREXGateway — access control
  // ═══════════════════════════════════════════════════════════════════

  it("non-approved deployer cannot deploy", async () => {
    const gatewayAsOutsider = gateway.connect(outsider);

    const slAddress = await supplyLimitModule.getAddress();
    const slAbi = supplyLimitModule.interface;
    const complianceSettings = slAbi.encodeFunctionData("setSupplyLimit", [
      SUPPLY_LIMIT,
    ]);

    const tokenDetails = {
      owner: outsider.address,
      name: "Outsider Bond",
      symbol: "OUT-01",
      decimals: 0,
      irs: ethers.ZeroAddress,
      ONCHAINID: ethers.ZeroAddress,
      irAgents: [registrar.address],
      tokenAgents: [bndSafe.address],
      complianceModules: [slAddress],
      complianceSettings: [complianceSettings],
    };

    const claimDetails = { claimTopics: [], issuers: [], issuerClaims: [] };

    await assert.rejects(
      async () => {
        await gatewayAsOutsider.deployTREXSuite(tokenDetails, claimDetails);
      },
      "non-approved deployer should revert"
    );
  });

  it("add and remove deployer works", async () => {
    await gateway.addDeployer(outsider.address);
    let isDeployer = await gateway.isDeployer(outsider.address);
    assert.equal(isDeployer, true, "should be deployer after add");

    await gateway.removeDeployer(outsider.address);
    isDeployer = await gateway.isDeployer(outsider.address);
    assert.equal(isDeployer, false, "should not be deployer after remove");
  });

  it("owner can always deploy", async () => {
    const slAddress = await supplyLimitModule.getAddress();
    const slAbi = supplyLimitModule.interface;
    const complianceSettings = slAbi.encodeFunctionData("setSupplyLimit", [
      SUPPLY_LIMIT,
    ]);

    const tokenDetails = {
      owner: platformAdmin.address,
      name: "Second Bond",
      symbol: "TR-02",
      decimals: 0,
      irs: ethers.ZeroAddress,
      ONCHAINID: ethers.ZeroAddress,
      irAgents: [registrar.address],
      tokenAgents: [bndSafe.address],
      complianceModules: [slAddress],
      complianceSettings: [complianceSettings],
    };

    const claimDetails = { claimTopics: [], issuers: [], issuerClaims: [] };

    // should not revert
    const tx = await gateway.deployTREXSuite(tokenDetails, claimDetails);
    await tx.wait();
  });

  it("public deployment mode allows anyone", async () => {
    await gateway.setPublicDeploymentStatus(true);

    const gatewayAsOutsider = gateway.connect(outsider);
    const slAddress = await supplyLimitModule.getAddress();
    const slAbi = supplyLimitModule.interface;
    const complianceSettings = slAbi.encodeFunctionData("setSupplyLimit", [
      SUPPLY_LIMIT,
    ]);

    const tokenDetails = {
      owner: outsider.address,
      name: "Public Bond",
      symbol: "PUB-01",
      decimals: 0,
      irs: ethers.ZeroAddress,
      ONCHAINID: ethers.ZeroAddress,
      irAgents: [registrar.address],
      tokenAgents: [bndSafe.address],
      complianceModules: [slAddress],
      complianceSettings: [complianceSettings],
    };

    const claimDetails = { claimTopics: [], issuers: [], issuerClaims: [] };

    const tx = await gatewayAsOutsider.deployTREXSuite(tokenDetails, claimDetails);
    await tx.wait();

    // reset for other tests
    await gateway.setPublicDeploymentStatus(false);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  1.3 TREXFactory — ONCHAINID removal
  // ═══════════════════════════════════════════════════════════════════

  it("factory constructor takes one param (IA is set)", async () => {
    const iaAddr = await factory.getImplementationAuthority();
    assert.equal(iaAddr, await ia.getAddress(), "IA not set");
  });

  it("getIdFactory does not exist", async () => {
    const iface = new ethers.Interface(["function getIdFactory() view returns (address)"]);
    const calldata = iface.encodeFunctionData("getIdFactory");
    try {
      await provider.call({
        to: await factory.getAddress(),
        data: calldata,
      });
      assert.fail("getIdFactory should not exist");
    } catch {
      // expected — function doesn't exist
    }
  });

  it("zero ONCHAINID means no identity contract deployed", async () => {
    const token = await getContractAt("Token", deal.token, deployer);
    const oid = await token.onchainID();
    assert.equal(oid, ethers.ZeroAddress, "onchainID should be zero");
    const code = await provider.getCode(oid);
    assert.equal(code, "0x", "no identity contract should be deployed");
  });
});
