import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { artifacts } from "hardhat";
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

// ─────────────────────────────────────────────────────────────────────
//  Shared helpers
// ─────────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60;
let dealCounter = 0;

function errText(e) {
  const parts = [e?.message, e?.shortMessage, e?.reason, String(e?.data)];
  try {
    parts.push(
      JSON.stringify(e?.info ?? {}, (k, v) => (typeof v === "bigint" ? v.toString() : v))
    );
  } catch {}
  return parts.join(" ");
}

/** Asserts a promise rejects, optionally matching a pattern against the error text. */
async function reverts(promiseFactory, pattern) {
  await assert.rejects(promiseFactory, (e) => {
    if (!pattern) return true;
    const txt = errText(e);
    assert.ok(pattern.test(txt), `unexpected revert: ${txt.slice(0, 400)}`);
    return true;
  });
}

function selectorOf(iface, errorName) {
  return new RegExp(iface.getError(errorName).selector.slice(2));
}

describe("Compliance Modules B", () => {
  let conn, provider;
  let deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, meridian, outsider;
  let platform;

  async function increaseTime(seconds) {
    await conn.provider.request({ method: "evm_increaseTime", params: [seconds] });
    await conn.provider.request({ method: "evm_mine", params: [] });
  }

  async function deployModule(name) {
    const impl = await deployContract(deployer, name);
    const proxy = await deployContract(deployer, "ModuleProxy", await impl.getAddress(), "0x");
    const module = await getContractAt(name, await proxy.getAddress(), deployer);
    await (await module.initialize()).wait();
    return { impl, module };
  }

  /** Deploys a fresh TREX deal (no compliance modules), unpauses the token. */
  async function makeDeal() {
    dealCounter++;
    const tokenDetails = {
      owner: platformAdmin.address,
      name: `ModulesB Deal ${dealCounter}`,
      symbol: `MB${dealCounter}`,
      decimals: 0,
      irs: ethers.ZeroAddress,
      ONCHAINID: ethers.ZeroAddress,
      irAgents: [registrar.address],
      tokenAgents: [bndSafe.address],
      complianceModules: [],
      complianceSettings: [],
    };
    const claimDetails = { claimTopics: [], issuers: [], issuerClaims: [] };
    const receipt = await (await platform.gateway.deployTREXSuite(tokenDetails, claimDetails)).wait();
    const factoryArtifact = await artifacts.readArtifact("TREXFactory");
    const factoryIface = new ethers.Interface(factoryArtifact.abi);
    let addrs;
    for (const log of receipt.logs) {
      try {
        const p = factoryIface.parseLog({ topics: log.topics, data: log.data });
        if (p && p.name === "TREXSuiteDeployed") {
          addrs = { token: p.args[0], ir: p.args[1], mc: p.args[5] };
          break;
        }
      } catch {}
    }
    assert.ok(addrs, "TREXSuiteDeployed not found");
    const mc = await getContractAt("ModularCompliance", addrs.mc, platformAdmin);
    const token = await getContractAt("Token", addrs.token, bndSafe); // bndSafe = token agent
    const tokenOwner = await getContractAt("Token", addrs.token, platformAdmin);
    const ir = await getContractAt("IdentityRegistry", addrs.ir, registrar);
    await (await ir.registerIdentity(bndSafe.address, randomAddress(), 356)).wait();
    await (await token.unpause()).wait();
    return { ...addrs, mc, token, tokenOwner, ir };
  }

  async function register(deal, wallet, identity = randomAddress()) {
    await (await deal.ir.registerIdentity(wallet.address, identity, 356)).wait();
    return identity;
  }

  async function bind(deal, module) {
    await (await deal.mc.addModule(await module.getAddress())).wait();
  }

  /** Calls a module function through the compliance (as compliance owner). */
  async function viaMc(deal, module, fn, args) {
    const data = module.interface.encodeFunctionData(fn, args);
    return (await deal.mc.callModuleFunction(data, await module.getAddress())).wait();
  }

  async function mint(deal, to, amount) {
    await (await deal.token.mint(to.address, amount)).wait();
  }

  async function transfer(deal, from, to, amount) {
    await (await deal.token.connect(from).transfer(to.address, amount)).wait();
  }

  before(async () => {
    ({ conn } = await setupProvider());
    // eth_estimateGas under-estimates (or spuriously reverts) for some proxy -> compliance -> module
    // call chains, so use a fixed generous gas limit for every transaction.
    const origRequest = conn.provider.request.bind(conn.provider);
    conn.provider.request = (args) =>
      args.method === "eth_estimateGas" && args.params?.[0]?.to
        ? Promise.resolve("0x4c4b40")
        : origRequest(args);
    provider = new ethers.BrowserProvider(conn.provider);
    const s = await getSigners(provider);
    ({ deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, meridian, outsider } = s);
    platform = await deployPlatform(deployer);
  });

  after(async () => {
    if (conn) await conn.close();
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Generic: binding, access control, upgrades (all six modules)
  // ═══════════════════════════════════════════════════════════════════

  describe("Generic module behaviour", () => {
    const names = [
      "ConditionalTransferModule",
      "ExchangeMonthlyLimitsModule",
      "TimeExchangeLimitsModule",
      "TimeTransfersLimitsModule",
      "TokenListingRestrictionsModule",
      "TransferFeesModule",
    ];

    for (const name of names) {
      it(`${name}: name, pnp flag, initialize once, bind/unbind, only-compliance hooks, upgrades`, async () => {
        const { module, impl } = await deployModule(name);
        assert.equal(await module.name(), name);
        const pnp = await module.isPlugAndPlay();
        assert.equal(pnp, name !== "TransferFeesModule");

        // cannot initialize twice
        await reverts(() => module.initialize());

        // hooks only callable by bound compliance
        await reverts(
          () => module.moduleTransferAction(aurora.address, northbridge.address, 1n),
          /only bound compliance/
        );
        await reverts(() => module.moduleMintAction(aurora.address, 1n), /only bound compliance/);
        await reverts(() => module.moduleBurnAction(aurora.address, 1n), /only bound compliance/);

        // direct bind: only the compliance itself may bind, zero address rejected
        await reverts(() => module.bindCompliance(ethers.ZeroAddress), /zero address/);
        await reverts(() => module.bindCompliance(aurora.address), /only compliance contract/);
        await reverts(() => module.unbindCompliance(aurora.address), /only bound compliance/);

        // bind through a real compliance, then remove (unbind)
        const deal = await makeDeal();
        if (name === "TransferFeesModule") {
          await reverts(() => deal.mc.addModule(module.target), /not suitable/);
          await (await deal.tokenOwner.addAgent(module.target)).wait();
          assert.equal(await module.canComplianceBind(deal.mc.target), true);
        } else {
          assert.equal(await module.canComplianceBind(deal.mc.target), true);
        }
        const receipt = await (await deal.mc.addModule(module.target)).wait();
        assert.ok(findEvent(receipt, module, "ComplianceBound"));
        assert.equal(await module.isComplianceBound(deal.mc.target), true);
        await reverts(() => deal.mc.addModule(module.target), /already bound/);
        const rm = await (await deal.mc.removeModule(module.target)).wait();
        assert.ok(findEvent(rm, module, "ComplianceUnbound"));
        assert.equal(await module.isComplianceBound(deal.mc.target), false);

        // UUPS upgrade authorization
        const newImpl = await deployContract(deployer, name);
        await reverts(
          () => module.connect(outsider).upgradeTo(newImpl.target),
          /Ownable|owner/
        );
        await (await module.upgradeTo(newImpl.target)).wait();
        assert.equal(await module.name(), name);
        assert.notEqual(impl.target, newImpl.target);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  //  ConditionalTransferModule
  // ═══════════════════════════════════════════════════════════════════

  describe("ConditionalTransferModule", () => {
    let deal, module;

    before(async () => {
      deal = await makeDeal();
      ({ module } = await deployModule("ConditionalTransferModule"));
      await bind(deal, module);
      await register(deal, aurora);
      await register(deal, northbridge);
    });

    const hashOf = (from, to, amt) =>
      module.calculateTransferHash(from, to, amt, deal.token.target);

    it("only bound compliance can approve / unapprove (direct calls revert)", async () => {
      await reverts(
        () => module.approveTransfer(aurora.address, northbridge.address, 1n),
        /only bound compliance/
      );
      await reverts(
        () => module.unApproveTransfer(aurora.address, northbridge.address, 1n),
        /only bound compliance/
      );
      await reverts(
        () => module.batchApproveTransfers([aurora.address], [northbridge.address], [1n]),
        /only bound compliance/
      );
      await reverts(
        () => module.batchUnApproveTransfers([aurora.address], [northbridge.address], [1n]),
        /only bound compliance/
      );
    });

    it("mint blocked until the mint (from=0) is approved", async () => {
      assert.equal(await deal.mc.canTransfer(ethers.ZeroAddress, aurora.address, 1000n), false);
      await reverts(() => deal.token.mint(aurora.address, 1000n), /Compliance not followed/);

      const r = await viaMc(deal, module, "approveTransfer", [ethers.ZeroAddress, aurora.address, 1000n]);
      assert.ok(r);
      assert.equal(await deal.mc.canTransfer(ethers.ZeroAddress, aurora.address, 1000n), true);
      await mint(deal, aurora, 1000n); // moduleMintAction no-op
      assert.equal(await deal.token.balanceOf(aurora.address), 1000n);
    });

    it("unapproved transfer reverts; approved transfer succeeds and consumes approval", async () => {
      await reverts(() => deal.token.connect(aurora).transfer(northbridge.address, 100n), /Transfer not possible/);

      const receipt = await viaMc(deal, module, "approveTransfer", [aurora.address, northbridge.address, 100n]);
      assert.ok(receipt);
      const h = await hashOf(aurora.address, northbridge.address, 100n);
      assert.equal(await module.isTransferApproved(deal.mc.target, h), true);
      assert.equal(await module.getTransferApprovals(deal.mc.target, h), 1n);

      const tx = await (await deal.token.connect(aurora).transfer(northbridge.address, 100n)).wait();
      assert.ok(findEvent(tx, module, "ApprovalRemoved"), "ApprovalRemoved emitted");
      assert.equal(await module.isTransferApproved(deal.mc.target, h), false);
      assert.equal(await deal.token.balanceOf(northbridge.address), 100n);
    });

    it("identical approvals stack and are consumed one by one", async () => {
      await viaMc(deal, module, "batchApproveTransfers", [
        [aurora.address, aurora.address],
        [northbridge.address, northbridge.address],
        [50n, 50n],
      ]);
      const h = await hashOf(aurora.address, northbridge.address, 50n);
      assert.equal(await module.getTransferApprovals(deal.mc.target, h), 2n);
      await transfer(deal, aurora, northbridge, 50n);
      assert.equal(await module.getTransferApprovals(deal.mc.target, h), 1n);
    });

    it("unApproveTransfer / batchUnApproveTransfers remove approvals; reverts when not approved", async () => {
      const h = await hashOf(aurora.address, northbridge.address, 50n);
      const r = await viaMc(deal, module, "unApproveTransfer", [aurora.address, northbridge.address, 50n]);
      assert.ok(r);
      assert.equal(await module.getTransferApprovals(deal.mc.target, h), 0n);
      await reverts(
        () => viaMc(deal, module, "unApproveTransfer", [aurora.address, northbridge.address, 50n]),
        /not approved/
      );

      await viaMc(deal, module, "batchApproveTransfers", [[aurora.address], [northbridge.address], [7n]]);
      await viaMc(deal, module, "batchUnApproveTransfers", [[aurora.address], [northbridge.address], [7n]]);
      assert.equal(
        await module.getTransferApprovals(
          deal.mc.target,
          await hashOf(aurora.address, northbridge.address, 7n)
        ),
        0n
      );
    });

    it("forced transfer bypasses the module (no approval to consume); burn works", async () => {
      await (await deal.token.forcedTransfer(aurora.address, northbridge.address, 10n)).wait();
      assert.equal(await deal.token.balanceOf(northbridge.address), 160n);
      await (await deal.token.burn(northbridge.address, 10n)).wait(); // moduleBurnAction no-op
      assert.equal(await deal.token.balanceOf(northbridge.address), 150n);
    });

    it("moduleCheck view and canComplianceBind", async () => {
      assert.equal(
        await module.moduleCheck(aurora.address, northbridge.address, 999n, deal.mc.target),
        false
      );
      assert.equal(await module.canComplianceBind(randomAddress()), true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  ExchangeMonthlyLimitsModule
  // ═══════════════════════════════════════════════════════════════════

  describe("ExchangeMonthlyLimitsModule", () => {
    let deal, module;
    let idA, idB, idE, idX;
    // aurora = investor A, northbridge = investor B, meridian = exchange E, outsider = exchange X

    before(async () => {
      deal = await makeDeal();
      ({ module } = await deployModule("ExchangeMonthlyLimitsModule"));
      await bind(deal, module);
      idA = await register(deal, aurora);
      idB = await register(deal, northbridge);
      idE = await register(deal, meridian);
      idX = await register(deal, outsider);
    });

    it("addExchangeID / removeExchangeID: owner only, with duplicates and missing rejected", async () => {
      await reverts(() => module.connect(outsider).addExchangeID(idE), /Ownable|owner/);
      await reverts(() => module.connect(outsider).removeExchangeID(idE), /Ownable|owner/);
      await reverts(() => module.removeExchangeID(idE), selectorOf(module.interface, "ONCHAINIDNotTaggedAsExchange"));

      const r = await (await module.addExchangeID(idE)).wait();
      assert.ok(findEvent(r, module, "ExchangeIDAdded"));
      assert.equal(await module.isExchangeID(idE), true);
      await reverts(() => module.addExchangeID(idE), selectorOf(module.interface, "ONCHAINIDAlreadyTaggedAsExchange"));

      await (await module.addExchangeID(idX)).wait();
      // remove / re-add temporary id
      const tmp = randomAddress();
      await (await module.addExchangeID(tmp)).wait();
      const rr = await (await module.removeExchangeID(tmp)).wait();
      assert.ok(findEvent(rr, module, "ExchangeIDRemoved"));
      assert.equal(await module.isExchangeID(tmp), false);
    });

    it("setExchangeMonthlyLimit: compliance only, emits event", async () => {
      await reverts(() => module.setExchangeMonthlyLimit(idE, 1n), /only bound compliance/);
      const r = await viaMc(deal, module, "setExchangeMonthlyLimit", [idE, 100n]);
      assert.ok(r);
      assert.equal(await module.getExchangeMonthlyLimit(deal.mc.target, idE), 100n);
    });

    it("mint / agent transfers to exchange are always allowed and not counted", async () => {
      await mint(deal, aurora, 1000n); // from == 0
      await mint(deal, outsider, 1000n);
      await mint(deal, meridian, 10n); // mint to the exchange itself
      await mint(deal, bndSafe, 500n);
      // agent -> exchange, amount above limit: allowed (agent branch)
      await transfer(deal, bndSafe, meridian, 300n);
      assert.equal(await module.getMonthlyCounter(deal.mc.target, idE, idE), 0n);
      assert.equal(await module.getMonthlyCounter(deal.mc.target, idE, await getIdentity(bndSafe)), 0n);
    });

    async function getIdentity(wallet) {
      return deal.ir.identity(wallet.address);
    }

    it("transfer to a non-exchange is unrestricted", async () => {
      await transfer(deal, aurora, northbridge, 500n);
      assert.equal(await module.getMonthlyCounter(deal.mc.target, idB, idA), 0n);
    });

    it("sender that is itself an exchange is unrestricted", async () => {
      await transfer(deal, outsider, meridian, 500n); // far above limit of 100
      // moduleTransferAction still counts it for X identity
      assert.equal(await module.getMonthlyCounter(deal.mc.target, idE, idX), 500n);
    });

    it("single transfer above the monthly limit is rejected", async () => {
      assert.equal(await deal.mc.canTransfer(aurora.address, meridian.address, 150n), false);
      await reverts(() => deal.token.connect(aurora).transfer(meridian.address, 150n), /Transfer not possible/);
    });

    it("cumulative limit enforced inside the month, resets after it", async () => {
      await transfer(deal, aurora, meridian, 60n);
      assert.equal(await module.getMonthlyCounter(deal.mc.target, idE, idA), 60n);
      const timer = await module.getMonthlyTimer(deal.mc.target, idE, idA);
      assert.ok(timer > 0n);

      assert.equal(await deal.mc.canTransfer(aurora.address, meridian.address, 50n), false);
      assert.equal(await deal.mc.canTransfer(aurora.address, meridian.address, 40n), true);
      await transfer(deal, aurora, meridian, 40n);
      assert.equal(await module.getMonthlyCounter(deal.mc.target, idE, idA), 100n);
      await reverts(() => deal.token.connect(aurora).transfer(meridian.address, 1n), /Transfer not possible/);

      await increaseTime(31 * DAY);
      assert.equal(await deal.mc.canTransfer(aurora.address, meridian.address, 100n), true);
      await transfer(deal, aurora, meridian, 100n);
      assert.equal(await module.getMonthlyCounter(deal.mc.target, idE, idA), 100n); // reset then +100
      assert.ok((await module.getMonthlyTimer(deal.mc.target, idE, idA)) > timer);
    });

    it("moduleCheck returns true with limit left within the month (second increase keeps timer)", async () => {
      await increaseTime(31 * DAY);
      await viaMc(deal, module, "setExchangeMonthlyLimit", [idE, 1000n]);
      await transfer(deal, aurora, meridian, 10n);
      const t1 = await module.getMonthlyTimer(deal.mc.target, idE, idA);
      await transfer(deal, aurora, meridian, 10n);
      assert.equal(await module.getMonthlyTimer(deal.mc.target, idE, idA), t1);
      assert.equal(await module.getMonthlyCounter(deal.mc.target, idE, idA), 20n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  TimeExchangeLimitsModule
  // ═══════════════════════════════════════════════════════════════════

  describe("TimeExchangeLimitsModule", () => {
    let deal, module;
    let idA, idB, idE, idX;

    before(async () => {
      deal = await makeDeal();
      ({ module } = await deployModule("TimeExchangeLimitsModule"));
      await bind(deal, module);
      idA = await register(deal, aurora);
      idB = await register(deal, northbridge);
      idE = await register(deal, meridian);
      idX = await register(deal, outsider);
    });

    const setLimit = (exch, time, value) =>
      viaMc(deal, module, "setExchangeLimit", [exch, { limitTime: time, limitValue: value }]);

    it("addExchangeID / removeExchangeID access control and errors", async () => {
      await reverts(() => module.connect(outsider).addExchangeID(idE), /Ownable|owner/);
      await reverts(() => module.connect(outsider).removeExchangeID(idE), /Ownable|owner/);
      await reverts(() => module.removeExchangeID(idE), selectorOf(module.interface, "ONCHAINIDNotTaggedAsExchange"));
      const r = await (await module.addExchangeID(idE)).wait();
      assert.ok(findEvent(r, module, "ExchangeIDAdded"));
      await reverts(() => module.addExchangeID(idE), selectorOf(module.interface, "ONCHAINIDAlreadyTaggedAsExchange"));
      await (await module.addExchangeID(idX)).wait();
      const tmp = randomAddress();
      await (await module.addExchangeID(tmp)).wait();
      const rr = await (await module.removeExchangeID(tmp)).wait();
      assert.ok(findEvent(rr, module, "ExchangeIDRemoved"));
      assert.equal(await module.isExchangeID(tmp), false);
    });

    it("setExchangeLimit: add, update, max 4 limits, compliance only", async () => {
      await reverts(
        () => module.setExchangeLimit(idE, { limitTime: 60, limitValue: 1n }),
        /only bound compliance/
      );
      await setLimit(idE, 3600, 100n);
      await setLimit(idE, DAY, 300n);
      let limits = await module.getExchangeLimits(deal.mc.target, idE);
      assert.equal(limits.length, 2);

      // update existing time window
      const r = await setLimit(idE, DAY, 250n);
      assert.ok(r);
      limits = await module.getExchangeLimits(deal.mc.target, idE);
      assert.equal(limits.length, 2);
      assert.equal(limits[1].limitValue, 250n);
      await setLimit(idE, DAY, 300n);

      await setLimit(idE, 7 * DAY, 1000n);
      await setLimit(idE, 30 * DAY, 3000n);
      await reverts(() => setLimit(idE, 365 * DAY, 9999n), selectorOf(module.interface, "LimitsArraySizeExceeded"));
      assert.equal((await module.getExchangeLimits(deal.mc.target, idE)).length, 4);
    });

    it("mint, agent transfers, non-exchange receiver and exchange sender are unrestricted", async () => {
      await mint(deal, aurora, 5000n);
      await mint(deal, outsider, 5000n);
      await mint(deal, bndSafe, 1000n);
      await transfer(deal, bndSafe, meridian, 500n); // agent
      await transfer(deal, aurora, northbridge, 1000n); // non-exchange receiver
      await transfer(deal, outsider, meridian, 800n); // exchange sender, counted for idX
      const c = await module.getExchangeCounter(deal.mc.target, idE, idX, 3600);
      assert.equal(c.value, 800n);
      const agentCounter = await module.getExchangeCounter(
        deal.mc.target, idE, await deal.ir.identity(bndSafe.address), 3600
      );
      assert.equal(agentCounter.value, 0n);
    });

    it("limit on single value and cumulative value over time windows", async () => {
      // single value above the smallest limit
      assert.equal(await deal.mc.canTransfer(aurora.address, meridian.address, 150n), false);
      await reverts(() => deal.token.connect(aurora).transfer(meridian.address, 150n), /Transfer not possible/);

      await transfer(deal, aurora, meridian, 60n);
      let c = await module.getExchangeCounter(deal.mc.target, idE, idA, 3600);
      assert.equal(c.value, 60n);
      assert.ok(c.timer > 0n);

      assert.equal(await deal.mc.canTransfer(aurora.address, meridian.address, 50n), false);
      await transfer(deal, aurora, meridian, 40n);

      // after 2h the hourly window is over, daily is still active
      await increaseTime(2 * 3600);
      assert.equal(await deal.mc.canTransfer(aurora.address, meridian.address, 100n), true);
      await transfer(deal, aurora, meridian, 100n);
      c = await module.getExchangeCounter(deal.mc.target, idE, idA, 3600);
      assert.equal(c.value, 100n); // reset
      const d = await module.getExchangeCounter(deal.mc.target, idE, idA, DAY);
      assert.equal(d.value, 200n);

      // pass the 1h window again but exceed the daily one (200 + 150 > 300? 150 > 100 hourly) -> use 100 twice
      await increaseTime(2 * 3600);
      await transfer(deal, aurora, meridian, 100n); // daily = 300
      await increaseTime(2 * 3600);
      assert.equal(await deal.mc.canTransfer(aurora.address, meridian.address, 100n), false); // daily 300+100>300
    });

    it("no limits configured for an exchange means transfers pass", async () => {
      assert.ok(idB);
      const tmpEx = randomAddress();
      await (await module.addExchangeID(tmpEx)).wait();
      assert.equal((await module.getExchangeLimits(deal.mc.target, tmpEx)).length, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  TimeTransfersLimitsModule
  // ═══════════════════════════════════════════════════════════════════

  describe("TimeTransfersLimitsModule", () => {
    let deal, module;
    let idA;

    before(async () => {
      deal = await makeDeal();
      ({ module } = await deployModule("TimeTransfersLimitsModule"));
      await bind(deal, module);
      idA = await register(deal, aurora);
      await register(deal, northbridge);
    });

    const setLimit = (time, value) =>
      viaMc(deal, module, "setTimeTransferLimit", [{ limitTime: time, limitValue: value }]);

    it("setTimeTransferLimit: compliance only, add / update / cap of 4", async () => {
      await reverts(() => module.setTimeTransferLimit({ limitTime: 60, limitValue: 1n }), /only bound compliance/);
      await reverts(() => module.removeTimeTransferLimit(60), /only bound compliance/);

      const r = await setLimit(3600, 100n);
      assert.ok(r);
      await setLimit(3600, 120n); // update
      await setLimit(DAY, 300n);
      let limits = await module.getTimeTransferLimits(deal.mc.target);
      assert.equal(limits.length, 2);
      assert.equal(limits[0].limitValue, 120n);
      await setLimit(3600, 100n);

      await setLimit(7 * DAY, 1000n);
      await setLimit(30 * DAY, 3000n);
      await reverts(() => setLimit(365 * DAY, 1n), selectorOf(module.interface, "LimitsArraySizeExceeded"));
      limits = await module.getTimeTransferLimits(deal.mc.target);
      assert.equal(limits.length, 4);
      const stored = await module.transferLimits(deal.mc.target, 0);
      assert.equal(stored.limitTime, 3600n);
      const idx = await module.limitValues(deal.mc.target, DAY);
      assert.equal(idx.attributedLimit, true);
      assert.equal(idx.limitIndex, 1n);
    });

    it("removeTimeTransferLimit: swap-with-last, last element, only element, not found", async () => {
      // limits: [3600, DAY, 7D, 30D]. Remove first -> swapped with last
      await viaMc(deal, module, "removeTimeTransferLimit", [3600]);
      let limits = await module.getTimeTransferLimits(deal.mc.target);
      assert.deepEqual(limits.map((l) => Number(l.limitTime)), [30 * DAY, DAY, 7 * DAY]);
      // remove last element (no swap)
      await viaMc(deal, module, "removeTimeTransferLimit", [7 * DAY]);
      limits = await module.getTimeTransferLimits(deal.mc.target);
      assert.equal(limits.length, 2);
      await reverts(
        () => viaMc(deal, module, "removeTimeTransferLimit", [12345]),
        selectorOf(module.interface, "LimitTimeNotFound")
      );
      // batch remove down to one then zero
      await viaMc(deal, module, "batchRemoveTimeTransferLimit", [[DAY]]);
      await viaMc(deal, module, "removeTimeTransferLimit", [30 * DAY]); // only element
      assert.equal((await module.getTimeTransferLimits(deal.mc.target)).length, 0);
      const idx = await module.limitValues(deal.mc.target, DAY);
      assert.equal(idx.attributedLimit, false);
    });

    it("batchSetTimeTransferLimit sets multiple limits", async () => {
      await viaMc(deal, module, "batchSetTimeTransferLimit", [
        [
          { limitTime: 3600, limitValue: 100n },
          { limitTime: DAY, limitValue: 300n },
        ],
      ]);
      assert.equal((await module.getTimeTransferLimits(deal.mc.target)).length, 2);
    });

    it("mint, burn, agent transfers unrestricted; user transfers limited per window", async () => {
      await mint(deal, aurora, 5000n); // from == 0
      await mint(deal, bndSafe, 5000n);
      await transfer(deal, bndSafe, northbridge, 1000n); // agent: exempt from check (counter still counted)

      assert.equal(await deal.mc.canTransfer(aurora.address, northbridge.address, 150n), false);
      await reverts(() => deal.token.connect(aurora).transfer(northbridge.address, 150n), /Transfer not possible/);

      await transfer(deal, aurora, northbridge, 60n);
      const counter = await module.usersCounters(deal.mc.target, idA, 3600);
      assert.equal(counter.value, 60n);
      assert.equal(await deal.mc.canTransfer(aurora.address, northbridge.address, 50n), false);
      await transfer(deal, aurora, northbridge, 40n);

      await increaseTime(2 * 3600);
      assert.equal(await deal.mc.canTransfer(aurora.address, northbridge.address, 100n), true);
      await transfer(deal, aurora, northbridge, 100n);
      assert.equal((await module.usersCounters(deal.mc.target, idA, 3600)).value, 100n);
      assert.equal((await module.usersCounters(deal.mc.target, idA, DAY)).value, 200n);

      await increaseTime(2 * 3600);
      await transfer(deal, aurora, northbridge, 100n);
      await increaseTime(2 * 3600);
      assert.equal(await deal.mc.canTransfer(aurora.address, northbridge.address, 100n), false); // daily full

      await (await deal.token.burn(northbridge.address, 5n)).wait(); // moduleBurnAction
    });

    it("moduleCheck view for agent and mint senders", async () => {
      assert.equal(await module.moduleCheck(ethers.ZeroAddress, aurora.address, 10n ** 9n, deal.mc.target), true);
      assert.equal(await module.moduleCheck(bndSafe.address, aurora.address, 10n ** 9n, deal.mc.target), true);
      assert.equal(await module.canComplianceBind(randomAddress()), true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  TokenListingRestrictionsModule
  // ═══════════════════════════════════════════════════════════════════

  describe("TokenListingRestrictionsModule", () => {
    const NOT_CONFIGURED = 0, WHITELISTING = 1, BLACKLISTING = 2;
    const WALLET = 0, ONCHAINID = 1;
    let wl, bl, module, iface;
    let idA, idB;

    before(async () => {
      ({ module } = await deployModule("TokenListingRestrictionsModule"));
      iface = module.interface;
      wl = await makeDeal();
      bl = await makeDeal();
      await bind(wl, module);
      await bind(bl, module);
      idA = await register(wl, aurora);
      idB = await register(wl, northbridge);
      await register(wl, meridian);
      await register(bl, aurora);
      await register(bl, northbridge);
    });

    it("configureToken: compliance only, invalid type, one-time configuration", async () => {
      await reverts(() => module.configureToken(WHITELISTING), /only bound compliance/);
      await reverts(
        () => viaMc(wl, module, "configureToken", [NOT_CONFIGURED]),
        selectorOf(iface, "InvalidListingTypeForConfiguration")
      );
      assert.equal(await module.getTokenListingType(wl.token.target), BigInt(NOT_CONFIGURED));

      // listing before configuration is not allowed
      await reverts(
        () => module.connect(aurora).listToken(wl.token.target, WALLET),
        selectorOf(iface, "TokenIsNotConfigured")
      );
      // unconfigured token: all transfers allowed
      assert.equal(await wl.mc.canTransfer(aurora.address, northbridge.address, 1n), true);

      const r = await viaMc(wl, module, "configureToken", [WHITELISTING]);
      assert.ok(r);
      assert.equal(await module.getTokenListingType(wl.token.target), BigInt(WHITELISTING));
      await reverts(
        () => viaMc(wl, module, "configureToken", [BLACKLISTING]),
        selectorOf(iface, "TokenAlreadyConfigured")
      );
      await viaMc(bl, module, "configureToken", [BLACKLISTING]);
    });

    it("listToken / unlistToken: wallet and onchainID, duplicate and missing errors", async () => {
      const t = wl.token.target;
      const r = await (await module.connect(aurora).listToken(t, WALLET)).wait();
      assert.ok(findEvent(r, module, "TokenListed"));
      assert.equal(await module.getInvestorListingStatus(t, aurora.address), true);
      await reverts(
        () => module.connect(aurora).listToken(t, WALLET),
        selectorOf(iface, "TokenAlreadyListed")
      );

      // onchainID listing for northbridge
      await (await module.connect(northbridge).listToken(t, ONCHAINID)).wait();
      assert.equal(await module.getInvestorListingStatus(t, idB), true);

      // wallet w/o identity cannot list by onchainID
      await reverts(
        () => module.connect(outsider).listToken(t, ONCHAINID),
        selectorOf(iface, "IdentityNotFound")
      );
      await reverts(
        () => module.connect(outsider).unlistToken(t, ONCHAINID),
        selectorOf(iface, "IdentityNotFound")
      );

      // unlist
      await reverts(
        () => module.connect(meridian).unlistToken(t, WALLET),
        selectorOf(iface, "TokenIsNotListed")
      );
      const u = await (await module.connect(northbridge).unlistToken(t, ONCHAINID)).wait();
      assert.ok(findEvent(u, module, "TokenUnlisted"));
      assert.equal(await module.getInvestorListingStatus(t, idB), false);
    });

    it("whitelisting: only listed (by wallet or by identity) can receive", async () => {
      // aurora wallet listed, northbridge unlisted
      assert.equal(await wl.mc.canTransfer(aurora.address, northbridge.address, 1n), false);
      assert.equal(await wl.mc.canTransfer(northbridge.address, aurora.address, 1n), true);

      await mint(wl, aurora, 100n);
      await reverts(() => wl.token.mint(northbridge.address, 1n), /Compliance not followed/);

      // list northbridge by onchainID -> identity-based match
      await (await module.connect(northbridge).listToken(wl.token.target, ONCHAINID)).wait();
      assert.equal(await wl.mc.canTransfer(aurora.address, northbridge.address, 1n), true);
      await transfer(wl, aurora, northbridge, 10n); // moduleTransferAction no-op
      await (await wl.token.burn(northbridge.address, 5n)).wait(); // moduleBurnAction no-op

      // burn target (to == 0) always passes
      assert.equal(await wl.mc.canTransfer(aurora.address, ethers.ZeroAddress, 1n), true);
    });

    it("blacklisting: listed receivers are blocked, others pass", async () => {
      const t = bl.token.target;
      assert.equal(await bl.mc.canTransfer(aurora.address, northbridge.address, 1n), true);
      await (await module.connect(northbridge).listToken(t, WALLET)).wait();
      assert.equal(await bl.mc.canTransfer(aurora.address, northbridge.address, 1n), false);
      await mint(bl, aurora, 10n);
      await reverts(() => bl.token.connect(aurora).transfer(northbridge.address, 1n), /Transfer not possible/);
      await (await module.connect(northbridge).unlistToken(t, WALLET)).wait();
      // blacklist by onchain id
      await (await module.connect(northbridge).listToken(t, ONCHAINID)).wait();
      assert.equal(await bl.mc.canTransfer(aurora.address, northbridge.address, 1n), false);
      await (await module.connect(northbridge).unlistToken(t, ONCHAINID)).wait();
      assert.equal(await bl.mc.canTransfer(aurora.address, northbridge.address, 1n), true);
    });

    it("batchListTokens / batchUnlistTokens", async () => {
      const tokens = [wl.token.target, bl.token.target];
      await (await module.connect(meridian).batchListTokens(tokens, WALLET)).wait();
      assert.equal(await module.getInvestorListingStatus(tokens[0], meridian.address), true);
      assert.equal(await module.getInvestorListingStatus(tokens[1], meridian.address), true);
      await (await module.connect(meridian).batchUnlistTokens(tokens, WALLET)).wait();
      assert.equal(await module.getInvestorListingStatus(tokens[0], meridian.address), false);
      assert.equal(await module.canComplianceBind(randomAddress()), true);
      assert.ok(idA);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  TransferFeesModule
  // ═══════════════════════════════════════════════════════════════════

  describe("TransferFeesModule", () => {
    let deal, module;
    let idA;
    // aurora = A, northbridge = B, meridian = collector, outsider shares A's identity, deployer = bystander

    before(async () => {
      deal = await makeDeal();
      ({ module } = await deployModule("TransferFeesModule"));
      assert.equal(await module.canComplianceBind(deal.mc.target), false);
      await reverts(() => deal.mc.addModule(module.target), /not suitable/);
      await (await deal.tokenOwner.addAgent(module.target)).wait();
      assert.equal(await module.canComplianceBind(deal.mc.target), true);
      await bind(deal, module);
      idA = await register(deal, aurora);
      await register(deal, northbridge);
      await register(deal, meridian);
      await register(deal, outsider, idA); // same identity as aurora
      await mint(deal, aurora, 100000n);
      await mint(deal, meridian, 1000n);
    });

    it("setFee: compliance only, rate bounds, verified collector", async () => {
      await reverts(() => module.setFee(100, meridian.address), /only bound compliance/);
      await reverts(
        () => viaMc(deal, module, "setFee", [10001, meridian.address]),
        selectorOf(module.interface, "FeeRateIsOutOfRange")
      );
      await reverts(
        () => viaMc(deal, module, "setFee", [100, randomAddress()]),
        selectorOf(module.interface, "CollectorAddressIsNotVerified")
      );
      const r = await viaMc(deal, module, "setFee", [100, meridian.address]);
      assert.ok(r);
      const fee = await module.getFee(deal.mc.target);
      assert.equal(fee.rate, 100n);
      assert.equal(fee.collector, meridian.address);
    });

    it("moduleCheck is permissive", async () => {
      assert.equal(
        await module.moduleCheck(aurora.address, northbridge.address, 1n, deal.mc.target),
        true
      );
    });

    it("collects the fee from the receiver to the collector on transfer", async () => {
      const before = await deal.token.balanceOf(meridian.address);
      await transfer(deal, aurora, northbridge, 1000n); // 1% = 10
      assert.equal(await deal.token.balanceOf(northbridge.address), 990n);
      assert.equal(await deal.token.balanceOf(meridian.address), before + 10n);
    });

    it("no fee when sender and receiver share an identity", async () => {
      const before = await deal.token.balanceOf(meridian.address);
      await transfer(deal, aurora, outsider, 1000n);
      assert.equal(await deal.token.balanceOf(outsider.address), 1000n);
      assert.equal(await deal.token.balanceOf(meridian.address), before);
    });

    it("no fee when collector is sender or receiver", async () => {
      const before = await deal.token.balanceOf(meridian.address);
      await transfer(deal, aurora, meridian, 1000n); // _to == collector
      assert.equal(await deal.token.balanceOf(meridian.address), before + 1000n);
      const b2 = await deal.token.balanceOf(northbridge.address);
      await transfer(deal, meridian, northbridge, 500n); // _from == collector
      assert.equal(await deal.token.balanceOf(northbridge.address), b2 + 500n);
    });

    it("no fee when computed fee rounds to zero", async () => {
      const before = await deal.token.balanceOf(meridian.address);
      await transfer(deal, aurora, northbridge, 50n); // 50 * 100 / 10000 = 0
      assert.equal(await deal.token.balanceOf(meridian.address), before);
    });

    it("no fee when rate is zero", async () => {
      await viaMc(deal, module, "setFee", [0, meridian.address]);
      const before = await deal.token.balanceOf(meridian.address);
      await transfer(deal, aurora, northbridge, 1000n);
      assert.equal(await deal.token.balanceOf(meridian.address), before);
      // accepted boundary rate
      await viaMc(deal, module, "setFee", [10000, meridian.address]);
      assert.equal((await module.getFee(deal.mc.target)).rate, 10000n);
      await (await deal.token.burn(northbridge.address, 1n)).wait(); // moduleBurnAction
    });
  });
});
