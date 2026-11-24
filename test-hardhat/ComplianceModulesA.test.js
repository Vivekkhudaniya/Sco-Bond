import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  setupProvider,
  getSigners,
  deployPlatform,
  deployContract,
  getContractAt,
  findEvent,
  randomAddress,
} from "./helpers.js";

describe("Compliance Modules A (Allow / Restrict / MaxBalance / TransferRestrict)", () => {
  let conn, provider;
  let deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, meridian, outsider;
  let platform;
  const GAS = { gasLimit: 3_000_000 };

  before(async () => {
    ({ conn, provider } = await setupProvider());
    ({ deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, meridian, outsider } =
      await getSigners(provider));
    platform = await deployPlatform(deployer);
  });

  after(async () => {
    if (conn) await conn.close();
  });

  // ─── helpers ────────────────────────────────────────────────────────
  async function expectRevert(fn, pattern) {
    let err;
    try {
      await fn();
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected revert");
    if (pattern) {
      const blob = [err.message, err.shortMessage, err.data, err.reason, JSON.stringify(err.info ?? {})]
        .filter(Boolean)
        .join(" | ");
      const sel = pattern.includes("(") ? ethers.id(pattern).slice(0, 10) : null;
      const name = pattern.split("(")[0];
      assert.ok(
        blob.includes(pattern) || blob.includes(name) || (sel && blob.includes(sel)),
        `revert mismatch, wanted ${pattern}, got ${blob.slice(0, 400)}`
      );
    }
  }

  async function deployModule(name) {
    const impl = await deployContract(deployer, name);
    const proxy = await deployContract(deployer, "ModuleProxy", await impl.getAddress(), "0x");
    const mod = await getContractAt(name, await proxy.getAddress(), deployer);
    await (await mod.initialize()).wait();
    return { impl, mod };
  }

  let dealCounter = 0;
  async function newDeal() {
    dealCounter++;
    const slAddress = await platform.supplyLimitModule.getAddress();
    const tokenDetails = {
      owner: platformAdmin.address,
      name: `CMA Deal ${dealCounter}`,
      symbol: `CMA${dealCounter}`,
      decimals: 0,
      irs: ethers.ZeroAddress,
      ONCHAINID: ethers.ZeroAddress,
      irAgents: [registrar.address],
      tokenAgents: [bndSafe.address],
      complianceModules: [slAddress],
      complianceSettings: [platform.supplyLimitModule.interface.encodeFunctionData("setSupplyLimit", [5000n])],
    };
    const receipt = await (
      await platform.gateway.deployTREXSuite(tokenDetails, { claimTopics: [], issuers: [], issuerClaims: [] })
    ).wait();
    const factoryIface = (await getContractAt("TREXFactory", await platform.factory.getAddress(), deployer)).interface;
    const ev = findEvent(receipt, { interface: factoryIface }, "TREXSuiteDeployed");
    const deal = { token: ev.args[0], ir: ev.args[1], mc: ev.args[5] };
    const mc = await getContractAt("ModularCompliance", deal.mc, platformAdmin);
    const token = await getContractAt("Token", deal.token, bndSafe);
    const ir = await getContractAt("IdentityRegistry", deal.ir, registrar);
    await (await token.unpause()).wait();
    return { deal, mc, token, ir };
  }

  async function register(ir, signer, country) {
    await (await ir.registerIdentity(signer.address, randomAddress(), country)).wait();
  }

  async function call(mc, mod, fn, args = []) {
    const data = mod.interface.encodeFunctionData(fn, args);
    const tx = await mc.callModuleFunction(data, await mod.getAddress());
    return tx.wait();
  }

  function callRaw(mc, mod, fn, args = []) {
    return () => mc.callModuleFunction(mod.interface.encodeFunctionData(fn, args), mod.getAddress());
  }

  // Shared checks for AbstractModuleUpgradeable (used by all four modules)
  function abstractModuleSuite(getCtx, expectedName) {
    it("name / isPlugAndPlay / canComplianceBind", async () => {
      const { mod, mc, plug } = getCtx();
      assert.equal(await mod.name(), expectedName);
      assert.equal(await mod.isPlugAndPlay(), plug);
      if (plug) assert.equal(await mod.canComplianceBind(await mc.getAddress()), true);
    });

    it("compliance is bound, random address is not", async () => {
      const { mod, mc } = getCtx();
      assert.equal(await mod.isComplianceBound(await mc.getAddress()), true);
      assert.equal(await mod.isComplianceBound(randomAddress()), false);
    });

    it("bindCompliance reverts: zero address", async () => {
      const { mod } = getCtx();
      await expectRevert(() => mod.bindCompliance(ethers.ZeroAddress), "invalid argument - zero address");
    });

    it("bindCompliance reverts: already bound", async () => {
      const { mod, mc } = getCtx();
      await expectRevert(() => mod.bindCompliance(mc.getAddress()), "compliance already bound");
    });

    it("bindCompliance reverts: caller is not the compliance", async () => {
      const { mod } = getCtx();
      await expectRevert(() => mod.bindCompliance(outsider.address), "only compliance contract can call");
    });

    it("unbindCompliance reverts when caller is not bound compliance", async () => {
      const { mod, mc } = getCtx();
      await expectRevert(() => mod.unbindCompliance(mc.getAddress()), "only bound compliance can call");
    });

    it("unbindCompliance reverts: zero address (via bound compliance)", async () => {
      const { mod, mc } = getCtx();
      await expectRevert(callRaw(mc, mod, "unbindCompliance", [ethers.ZeroAddress]), "invalid argument - zero address");
    });

    it("unbindCompliance reverts: compliance param != caller", async () => {
      const { mod, mc } = getCtx();
      await expectRevert(
        callRaw(mc, mod, "unbindCompliance", [randomAddress()]),
        "only compliance contract can call"
      );
    });

    it("hooks revert when not called by bound compliance", async () => {
      const { mod } = getCtx();
      const a = randomAddress();
      await expectRevert(() => mod.moduleTransferAction(a, a, 1), "only bound compliance can call");
      await expectRevert(() => mod.moduleMintAction(a, 1), "only bound compliance can call");
      await expectRevert(() => mod.moduleBurnAction(a, 1), "only bound compliance can call");
    });

    it("hooks succeed when invoked by the bound compliance", async () => {
      const { mod, mc, hookSafe } = getCtx();
      if (!hookSafe) return;
      const a = randomAddress();
      const b = randomAddress();
      await call(mc, mod, "moduleTransferAction", [a, b, 0]);
      await call(mc, mod, "moduleMintAction", [a, 0]);
      await call(mc, mod, "moduleBurnAction", [a, 0]);
    });

    it("initialize cannot be called twice", async () => {
      const { mod } = getCtx();
      await expectRevert(() => mod.initialize(), "Initializable");
    });

    it("implementation cannot be used directly for upgrades by non-owner; owner-only upgrade", async () => {
      const { mod } = getCtx();
      const name = await mod.name();
      const newImpl = await deployContract(deployer, name);
      const asOutsider = mod.connect(outsider);
      await expectRevert(() => asOutsider.upgradeTo(newImpl.getAddress()), "Ownable: caller is not the owner");
      await (await mod.upgradeTo(await newImpl.getAddress())).wait();
      // state preserved after upgrade
      assert.equal(await mod.name(), name);
      assert.equal(await mod.owner(), deployer.address);
    });

    it("unbind via removeModule works, and rebind via addModule", async () => {
      const { mod, mc } = getCtx();
      const addr = await mod.getAddress();
      const r1 = await (await mc.removeModule(addr)).wait();
      assert.ok(findEvent(r1, mod, "ComplianceUnbound"));
      assert.equal(await mod.isComplianceBound(await mc.getAddress()), false);
      const r2 = await (await mc.addModule(addr)).wait();
      assert.ok(findEvent(r2, mod, "ComplianceBound"));
      assert.equal(await mod.isComplianceBound(await mc.getAddress()), true);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CountryAllowModule
  // ═══════════════════════════════════════════════════════════════════
  describe("CountryAllowModule", () => {
    let ctx = {};
    before(async () => {
      const d = await newDeal();
      const { mod } = await deployModule("CountryAllowModule");
      await (await d.mc.addModule(await mod.getAddress())).wait();
      ctx = { ...d, mod, plug: true, hookSafe: true };
      await register(d.ir, bndSafe, 356);
      await register(d.ir, aurora, 840);
      await register(d.ir, northbridge, 826);
    });

    abstractModuleSuite(() => ctx, "CountryAllowModule");

    it("addAllowedCountry emits event, sets state; duplicate reverts", async () => {
      const { mc, mod } = ctx;
      const r = await call(mc, mod, "addAllowedCountry", [356]);
      const ev = findEvent(r, mod, "CountryAllowed");
      assert.ok(ev);
      assert.equal(Number(ev.args[1]), 356);
      assert.equal(await mod.isCountryAllowed(await mc.getAddress(), 356), true);
      await expectRevert(callRaw(mc, mod, "addAllowedCountry", [356]), "CountryAlreadyAllowed(address,uint16)");
    });

    it("setters revert for non-compliance callers", async () => {
      const { mod } = ctx;
      await expectRevert(() => mod.addAllowedCountry(1), "only bound compliance can call");
      await expectRevert(() => mod.removeAllowedCountry(1), "only bound compliance can call");
      await expectRevert(() => mod.batchAllowCountries([1]), "only bound compliance can call");
      await expectRevert(() => mod.batchDisallowCountries([1]), "only bound compliance can call");
    });

    it("moduleCheck true for allowed receiver country, false otherwise", async () => {
      const { mc, mod } = ctx;
      const mcAddr = await mc.getAddress();
      assert.equal(await mod.moduleCheck(ethers.ZeroAddress, bndSafe.address, 1, mcAddr), true);
      assert.equal(await mod.moduleCheck(ethers.ZeroAddress, aurora.address, 1, mcAddr), false);
      assert.equal(await mc.canTransfer(ethers.ZeroAddress, aurora.address, 1), false);
    });

    it("batchAllowCountries allows multiple and emits events", async () => {
      const { mc, mod } = ctx;
      const r = await call(mc, mod, "batchAllowCountries", [[840, 826]]);
      const evs = r.logs
        .map((l) => { try { return mod.interface.parseLog(l); } catch { return null; } })
        .filter((e) => e && e.name === "CountryAllowed");
      assert.equal(evs.length, 2);
      assert.equal(await mod.isCountryAllowed(await mc.getAddress(), 840), true);
      assert.equal(await mod.isCountryAllowed(await mc.getAddress(), 826), true);
    });

    it("real mint, transfer, burn work through hooks when countries are allowed", async () => {
      const { token } = ctx;
      await (await token.mint(bndSafe.address, 100n)).wait();
      await (await token.transfer(aurora.address, 40n, GAS)).wait();
      await (await token.burn(aurora.address, 10n)).wait();
      assert.equal(await token.balanceOf(aurora.address), 30n);
    });

    it("removeAllowedCountry blocks transfers; removing again reverts", async () => {
      const { mc, mod, token } = ctx;
      const r = await call(mc, mod, "removeAllowedCountry", [826]);
      assert.ok(findEvent(r, mod, "CountryUnallowed"));
      assert.equal(await mod.isCountryAllowed(await mc.getAddress(), 826), false);
      await expectRevert(callRaw(mc, mod, "removeAllowedCountry", [826]), "CountryNotAllowed(address,uint16)");
      await expectRevert(() => token.transfer(northbridge.address, 1n));
    });

    it("batchDisallowCountries disallows and emits events", async () => {
      const { mc, mod } = ctx;
      const r = await call(mc, mod, "batchDisallowCountries", [[840, 356]]);
      const evs = r.logs
        .map((l) => { try { return mod.interface.parseLog(l); } catch { return null; } })
        .filter((e) => e && e.name === "CountryUnallowed");
      assert.equal(evs.length, 2);
      assert.equal(await mod.isCountryAllowed(await mc.getAddress(), 840), false);
    });

    it("empty batches are no-ops", async () => {
      const { mc, mod } = ctx;
      await call(mc, mod, "batchAllowCountries", [[]]);
      await call(mc, mod, "batchDisallowCountries", [[]]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  CountryRestrictModule
  // ═══════════════════════════════════════════════════════════════════
  describe("CountryRestrictModule", () => {
    let ctx = {};
    before(async () => {
      const d = await newDeal();
      const { mod } = await deployModule("CountryRestrictModule");
      await (await d.mc.addModule(await mod.getAddress())).wait();
      ctx = { ...d, mod, plug: true, hookSafe: true };
      await register(d.ir, bndSafe, 356);
      await register(d.ir, aurora, 840);
      await register(d.ir, northbridge, 826);
    });

    abstractModuleSuite(() => ctx, "CountryRestrictModule");

    it("setters revert for non-compliance callers", async () => {
      const { mod } = ctx;
      await expectRevert(() => mod.addCountryRestriction(1), "only bound compliance can call");
      await expectRevert(() => mod.removeCountryRestriction(1), "only bound compliance can call");
      await expectRevert(() => mod.batchRestrictCountries([1]), "only bound compliance can call");
      await expectRevert(() => mod.batchUnrestrictCountries([1]), "only bound compliance can call");
    });

    it("addCountryRestriction sets state/event; duplicate reverts", async () => {
      const { mc, mod } = ctx;
      const r = await call(mc, mod, "addCountryRestriction", [826]);
      const ev = findEvent(r, mod, "AddedRestrictedCountry");
      assert.ok(ev);
      assert.equal(Number(ev.args[1]), 826);
      assert.equal(await mod.isCountryRestricted(await mc.getAddress(), 826), true);
      await expectRevert(callRaw(mc, mod, "addCountryRestriction", [826]), "country already restricted");
    });

    it("moduleCheck false for restricted receiver, true otherwise", async () => {
      const { mc, mod, token } = ctx;
      const mcAddr = await mc.getAddress();
      assert.equal(await mod.moduleCheck(ethers.ZeroAddress, northbridge.address, 1, mcAddr), false);
      assert.equal(await mod.moduleCheck(ethers.ZeroAddress, aurora.address, 1, mcAddr), true);
      await (await token.mint(bndSafe.address, 50n)).wait();
      await (await token.transfer(aurora.address, 20n, GAS)).wait();
      await (await token.burn(aurora.address, 5n)).wait();
      await expectRevert(() => token.transfer(northbridge.address, 1n));
    });

    it("removeCountryRestriction unrestricts; second removal reverts", async () => {
      const { mc, mod, token } = ctx;
      const r = await call(mc, mod, "removeCountryRestriction", [826]);
      assert.ok(findEvent(r, mod, "RemovedRestrictedCountry"));
      assert.equal(await mod.isCountryRestricted(await mc.getAddress(), 826), false);
      await expectRevert(callRaw(mc, mod, "removeCountryRestriction", [826]), "country not restricted");
      await (await token.transfer(northbridge.address, 1n, GAS)).wait();
    });

    it("batchRestrictCountries restricts several; duplicate and size limit revert", async () => {
      const { mc, mod } = ctx;
      const r = await call(mc, mod, "batchRestrictCountries", [[1, 2, 3]]);
      const evs = r.logs
        .map((l) => { try { return mod.interface.parseLog(l); } catch { return null; } })
        .filter((e) => e && e.name === "AddedRestrictedCountry");
      assert.equal(evs.length, 3);
      assert.equal(await mod.isCountryRestricted(await mc.getAddress(), 2), true);
      await expectRevert(callRaw(mc, mod, "batchRestrictCountries", [[4, 1]]), "country already restricted");
      const tooMany = Array.from({ length: 195 }, (_, i) => i + 1000);
      await expectRevert(callRaw(mc, mod, "batchRestrictCountries", [tooMany]), "maximum 195 can be restricted");
    });

    it("batchUnrestrictCountries unrestricts; non-restricted and size limit revert", async () => {
      const { mc, mod } = ctx;
      const r = await call(mc, mod, "batchUnrestrictCountries", [[1, 2, 3]]);
      const evs = r.logs
        .map((l) => { try { return mod.interface.parseLog(l); } catch { return null; } })
        .filter((e) => e && e.name === "RemovedRestrictedCountry");
      assert.equal(evs.length, 3);
      assert.equal(await mod.isCountryRestricted(await mc.getAddress(), 2), false);
      await expectRevert(callRaw(mc, mod, "batchUnrestrictCountries", [[1]]), "country not restricted");
      const tooMany = Array.from({ length: 195 }, (_, i) => i + 1000);
      await expectRevert(callRaw(mc, mod, "batchUnrestrictCountries", [tooMany]), "maximum 195 can be unrestricted");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  TransferRestrictModule
  // ═══════════════════════════════════════════════════════════════════
  describe("TransferRestrictModule", () => {
    let ctx = {};
    before(async () => {
      const d = await newDeal();
      const { mod } = await deployModule("TransferRestrictModule");
      await (await d.mc.addModule(await mod.getAddress())).wait();
      ctx = { ...d, mod, plug: true, hookSafe: true };
      await register(d.ir, bndSafe, 356);
      await register(d.ir, aurora, 840);
      await register(d.ir, northbridge, 826);
    });

    abstractModuleSuite(() => ctx, "TransferRestrictModule");

    it("setters revert for non-compliance callers", async () => {
      const { mod } = ctx;
      await expectRevert(() => mod.allowUser(aurora.address), "only bound compliance can call");
      await expectRevert(() => mod.disallowUser(aurora.address), "only bound compliance can call");
      await expectRevert(() => mod.batchAllowUsers([aurora.address]), "only bound compliance can call");
      await expectRevert(() => mod.batchDisallowUsers([aurora.address]), "only bound compliance can call");
    });

    it("moduleCheck: zero from/to always true; unlisted pair false", async () => {
      const { mc, mod } = ctx;
      const mcAddr = await mc.getAddress();
      const Z = ethers.ZeroAddress;
      assert.equal(await mod.moduleCheck(Z, aurora.address, 1, mcAddr), true);
      assert.equal(await mod.moduleCheck(aurora.address, Z, 1, mcAddr), true);
      assert.equal(await mod.moduleCheck(aurora.address, northbridge.address, 1, mcAddr), false);
      assert.equal(await mc.canTransfer(aurora.address, northbridge.address, 1), false);
    });

    it("allowUser: sender-allowed passes", async () => {
      const { mc, mod } = ctx;
      const r = await call(mc, mod, "allowUser", [aurora.address]);
      assert.ok(findEvent(r, mod, "UserAllowed"));
      assert.equal(await mod.isUserAllowed(await mc.getAddress(), aurora.address), true);
      assert.equal(await mod.moduleCheck(aurora.address, northbridge.address, 1, await mc.getAddress()), true);
    });

    it("allowUser: receiver-allowed passes via second branch", async () => {
      const { mc, mod } = ctx;
      assert.equal(await mod.moduleCheck(northbridge.address, aurora.address, 1, await mc.getAddress()), true);
    });

    it("disallowUser removes permission", async () => {
      const { mc, mod } = ctx;
      const r = await call(mc, mod, "disallowUser", [aurora.address]);
      assert.ok(findEvent(r, mod, "UserDisallowed"));
      assert.equal(await mod.isUserAllowed(await mc.getAddress(), aurora.address), false);
    });

    it("batchAllowUsers / batchDisallowUsers", async () => {
      const { mc, mod } = ctx;
      const r = await call(mc, mod, "batchAllowUsers", [[aurora.address, northbridge.address]]);
      const n = r.logs.map((l) => { try { return mod.interface.parseLog(l); } catch { return null; } })
        .filter((e) => e && e.name === "UserAllowed").length;
      assert.equal(n, 2);
      assert.equal(await mod.isUserAllowed(await mc.getAddress(), northbridge.address), true);
      const r2 = await call(mc, mod, "batchDisallowUsers", [[aurora.address, northbridge.address]]);
      const m = r2.logs.map((l) => { try { return mod.interface.parseLog(l); } catch { return null; } })
        .filter((e) => e && e.name === "UserDisallowed").length;
      assert.equal(m, 2);
      assert.equal(await mod.isUserAllowed(await mc.getAddress(), aurora.address), false);
      await call(mc, mod, "batchAllowUsers", [[]]);
      await call(mc, mod, "batchDisallowUsers", [[]]);
    });

    it("real mint/transfer/burn flow honours allow-list", async () => {
      const { mc, mod, token } = ctx;
      await (await token.mint(bndSafe.address, 100n)).wait(); // from == 0
      await expectRevert(() => token.transfer(aurora.address, 10n)); // neither allowed
      await call(mc, mod, "allowUser", [bndSafe.address]);
      await (await token.transfer(aurora.address, 10n, GAS)).wait();
      await (await token.burn(aurora.address, 5n)).wait();
      assert.equal(await token.balanceOf(aurora.address), 5n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  MaxBalanceModule
  // ═══════════════════════════════════════════════════════════════════
  describe("MaxBalanceModule", () => {
    let ctx = {};
    let preMod, preDeal;

    before(async () => {
      // Main context: fresh token (supply 0), module bound, limits configured
      const d = await newDeal();
      const { mod } = await deployModule("MaxBalanceModule");
      await (await d.mc.addModule(await mod.getAddress())).wait();
      ctx = { ...d, mod, plug: false, hookSafe: false };
      await register(d.ir, bndSafe, 356);
      await register(d.ir, aurora, 840);
      await register(d.ir, northbridge, 826);
      // meridian intentionally has no identity
    });

    abstractModuleSuite(() => ctx, "MaxBalanceModule");

    it("hooks via bound compliance: identity not found reverts", async () => {
      const { mc, mod } = ctx;
      await expectRevert(callRaw(mc, mod, "moduleMintAction", [meridian.address, 1]), "identity not found");
    });

    it("setMaxBalance: only bound compliance; emits event", async () => {
      const { mc, mod } = ctx;
      await expectRevert(() => mod.setMaxBalance(100), "only bound compliance can call");
      const r = await call(mc, mod, "setMaxBalance", [500]);
      const ev = findEvent(r, mod, "MaxBalanceSet");
      assert.ok(ev);
      assert.equal(ev.args[1], 500n);
    });

    it("moduleCheck: value > max false; balance+value > max false; ok true", async () => {
      const { mc, mod } = ctx;
      const a = await mc.getAddress();
      assert.equal(await mod.moduleCheck(ethers.ZeroAddress, bndSafe.address, 501, a), false);
      assert.equal(await mod.moduleCheck(ethers.ZeroAddress, bndSafe.address, 500, a), true);
    });

    it("moduleCheck reverts for unregistered receiver", async () => {
      const { mc, mod } = ctx;
      await expectRevert(
        () => mod.moduleCheck(ethers.ZeroAddress, meridian.address, 1, mc.getAddress()),
        "identity not found"
      );
    });

    it("mint/transfer/burn update ID balances", async () => {
      const { mc, mod, token, ir } = ctx;
      const a = await mc.getAddress();
      await (await token.mint(bndSafe.address, 400n)).wait();
      const idB = await ir.identity(bndSafe.address);
      const idA = await ir.identity(aurora.address);
      assert.equal(await mod.getIDBalance(a, idB), 400n);
      await (await token.transfer(aurora.address, 150n, GAS)).wait();
      assert.equal(await mod.getIDBalance(a, idB), 250n);
      assert.equal(await mod.getIDBalance(a, idA), 150n);
      await (await token.burn(aurora.address, 50n)).wait();
      assert.equal(await mod.getIDBalance(a, idA), 100n);
    });

    it("moduleCheck false when resulting balance would exceed max; transfer reverts", async () => {
      const { mc, mod, token } = ctx;
      // bndSafe holds 250, aurora 100. Send aurora 450 -> exceeds
      assert.equal(await mod.moduleCheck(bndSafe.address, aurora.address, 450, await mc.getAddress()), false);
      await expectRevert(() => token.mint(aurora.address, 450n));
    });

    it("hook MaxBalanceExceeded reachable by direct compliance call", async () => {
      const { mc, mod } = ctx;
      await call(mc, mod, "setMaxBalance", [300]);
      await expectRevert(
        callRaw(mc, mod, "moduleMintAction", [aurora.address, 250]),
        "MaxBalanceExceeded(address,uint256)"
      );
      await expectRevert(
        callRaw(mc, mod, "moduleTransferAction", [bndSafe.address, aurora.address, 250]),
        "MaxBalanceExceeded(address,uint256)"
      );
    });

    it("canComplianceBind false when supply > 0 and no preset", async () => {
      const d = await newDeal();
      const { mod } = await deployModule("MaxBalanceModule");
      await register(d.ir, bndSafe, 356);
      assert.equal(await mod.canComplianceBind(await d.mc.getAddress()), true); // supply 0
      await (await d.token.mint(bndSafe.address, 10n)).wait();
      assert.equal(await mod.canComplianceBind(await d.mc.getAddress()), false);
      await expectRevert(
        () => d.mc.addModule(mod.getAddress()),
        "compliance is not suitable for binding to the module"
      );
      preMod = mod;
      preDeal = d;
    });

    it("preSetModuleState: only compliance owner", async () => {
      const mc = preDeal.mc;
      const mcAddr = await mc.getAddress();
      const id = randomAddress();
      await expectRevert(
        () => preMod.connect(outsider).preSetModuleState(mcAddr, id, 5),
        "OnlyComplianceOwnerCanCall(address)"
      );
      const r = await (await preMod.connect(platformAdmin).preSetModuleState(mcAddr, id, 5)).wait();
      const ev = findEvent(r, preMod, "IDBalancePreSet");
      assert.ok(ev);
      assert.equal(await preMod.getIDBalance(mcAddr, id), 5n);
    });

    it("batchPreSetModuleState: validation and owner checks", async () => {
      const mcAddr = await preDeal.mc.getAddress();
      const m = preMod.connect(platformAdmin);
      await expectRevert(() => m.batchPreSetModuleState(mcAddr, [], []), "InvalidPresetValues(address,address[],uint256[])");
      await expectRevert(
        () => m.batchPreSetModuleState(mcAddr, [randomAddress()], [1, 2]),
        "InvalidPresetValues(address,address[],uint256[])"
      );
      await expectRevert(
        () => preMod.connect(outsider).batchPreSetModuleState(mcAddr, [randomAddress()], [1]),
        "OnlyComplianceOwnerCanCall(address)"
      );
      const ids = [randomAddress(), randomAddress()];
      const r = await (await m.batchPreSetModuleState(mcAddr, ids, [7, 8])).wait();
      assert.ok(findEvent(r, preMod, "IDBalancePreSet"));
      assert.equal(await preMod.getIDBalance(mcAddr, ids[1]), 8n);
      // preset status set -> canComplianceBind true despite supply
      assert.equal(await preMod.canComplianceBind(mcAddr), true);
    });

    it("presetCompleted: owner only, emits event", async () => {
      const d = await newDeal();
      const { mod } = await deployModule("MaxBalanceModule");
      const mcAddr = await d.mc.getAddress();
      await register(d.ir, bndSafe, 356);
      await (await d.token.mint(bndSafe.address, 10n)).wait();
      await expectRevert(() => mod.connect(outsider).presetCompleted(mcAddr), "OnlyComplianceOwnerCanCall(address)");
      const r = await (await mod.connect(platformAdmin).presetCompleted(mcAddr)).wait();
      assert.ok(findEvent(r, mod, "PresetCompleted"));
      assert.equal(await mod.canComplianceBind(mcAddr), true);
      await (await d.mc.addModule(await mod.getAddress())).wait();
      // after binding, presets revert with TokenAlreadyBound
      const m = mod.connect(platformAdmin);
      await expectRevert(() => m.preSetModuleState(mcAddr, randomAddress(), 1), "TokenAlreadyBound(address)");
      await expectRevert(
        () => m.batchPreSetModuleState(mcAddr, [randomAddress()], [1]),
        "TokenAlreadyBound(address)"
      );
    });

    it("isPlugAndPlay false", async () => {
      assert.equal(await ctx.mod.isPlugAndPlay(), false);
    });
  });
});
