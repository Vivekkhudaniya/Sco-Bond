import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { artifacts } from "hardhat";
import { ethers } from "ethers";
import {
  setupProvider,
  getSigners,
  deployPlatform,
  deployContract,
  getContractAt,
  randomAddress,
  SUPPLY_LIMIT,
} from "./helpers.js";

const ZERO = ethers.ZeroAddress;
const ADMIN_ERR = "Role: Sender is NOT Admin";
const ALREADY = "Roles: account already has role";
const MISSING = "Roles: account does not have role";
const ZERO_ERR = "Roles: account is the zero address";

async function expectRevert(fn, reason) {
  let err;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected the call to revert, but it succeeded");
  if (reason) {
    const text = [err.message, err.shortMessage, err.reason, JSON.stringify(err.info ?? {})]
      .filter(Boolean)
      .join(" | ");
    assert.ok(text.includes(reason), `expected revert reason "${reason}", got: ${text}`);
  }
}

async function eventOf(tx, contract, name) {
  const receipt = await tx.wait();
  const addr = (await contract.getAddress()).toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== addr) continue;
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === name) return parsed;
    } catch {
      /* not this event */
    }
  }
  return undefined;
}

const AGENT_ROLES = [
  ["AgentAdmin", "AgentAdmin"],
  ["SupplyModifier", "SupplyModifier"],
  ["Freezer", "Freezer"],
  ["TransferManager", "TransferManager"],
  ["RecoveryAgent", "RecoveryAgent"],
  ["ComplianceAgent", "ComplianceAgent"],
  ["WhiteListManager", "WhiteListManager"],
];
const OWNER_ROLES = [
  ["OwnerAdmin", "OwnerAdmin"],
  ["RegistryAddressSetter", "RegistryAddressSetter"],
  ["ComplianceSetter", "ComplianceSetter"],
  ["ComplianceManager", "ComplianceManager"],
  ["ClaimRegistryManager", "ClaimRegistryManager"],
  ["IssuersRegistryManager", "IssuersRegistryManager"],
  ["TokenInfoManager", "TokenInfoManager"],
];

describe("Roles managers (AgentRoles/OwnerRoles/Managers)", () => {
  let provider;
  let deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, meridian, outsider;
  let op, other;
  let platform;
  let dealCounter = 0;

  before(async () => {
    ({ provider } = await setupProvider());
    ({ deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, meridian, outsider } =
      await getSigners(provider));
    const accounts = await provider.listAccounts();
    op = accounts[8];
    other = accounts[9];
    platform = await deployPlatform(deployer);
  });

  /** Deploys a fresh deal with a unique name; returns contracts connected to platformAdmin. */
  async function newDeal() {
    dealCounter += 1;
    const gateway = platform.gateway;
    const sl = platform.supplyLimitModule;
    const tokenDetails = {
      owner: platformAdmin.address,
      name: `RolesMgr Deal ${dealCounter}`,
      symbol: `RM-${dealCounter}`,
      decimals: 0,
      irs: ZERO,
      ONCHAINID: ZERO,
      irAgents: [registrar.address],
      tokenAgents: [bndSafe.address],
      complianceModules: [await sl.getAddress()],
      complianceSettings: [sl.interface.encodeFunctionData("setSupplyLimit", [SUPPLY_LIMIT])],
    };
    const claimDetails = { claimTopics: [], issuers: [], issuerClaims: [] };
    const receipt = await (await gateway.deployTREXSuite(tokenDetails, claimDetails)).wait();
    const fArt = await artifacts.readArtifact("TREXFactory");
    const iface = new ethers.Interface(fArt.abi);
    let a;
    for (const log of receipt.logs) {
      try {
        const p = iface.parseLog({ topics: log.topics, data: log.data });
        if (p && p.name === "TREXSuiteDeployed") {
          a = { token: p.args[0], ir: p.args[1], irs: p.args[2], tir: p.args[3], ctr: p.args[4], mc: p.args[5] };
          break;
        }
      } catch {
        /* skip */
      }
    }
    assert.ok(a, "TREXSuiteDeployed not found");
    return {
      addrs: a,
      token: await getContractAt("Token", a.token, platformAdmin),
      ir: await getContractAt("IdentityRegistry", a.ir, platformAdmin),
      tir: await getContractAt("TrustedIssuersRegistry", a.tir, platformAdmin),
      ctr: await getContractAt("ClaimTopicsRegistry", a.ctr, platformAdmin),
      mc: await getContractAt("ModularCompliance", a.mc, platformAdmin),
    };
  }

  /**
   * Stub ONCHAINID (runtime code answers every call with a bool). The Identity artifact from
   * @onchain-id is not compiled here, and the managers only call keyHasPurpose(), so a
   * stub returning true (sender holds the key) or false (sender lacks the key) is enough.
   */
  async function newIdentity(keyOwner) {
    const holdsKey = keyOwner !== other;
    const addr = randomAddress();
    const ret = holdsKey ? "0x6001600052" : "0x6000600052";
    await provider.send("hardhat_setCode", [addr, ret + "60206000f3"]);
    return addr;
  }

  const count = (n) => Array.from({ length: n }, (_, i) => i);

  // ═══════════════════════════════════════════════════════════════════
  //  Generic role-contract suite (AgentRoles / OwnerRoles + upgradeable)
  // ═══════════════════════════════════════════════════════════════════

  function rolesSuite(title, contractName, roles, prefix, upgradeable) {
    describe(title, () => {
      let c, asAdmin, asOutsider;

      const fn = (verb, role) => `${verb}${role}`;
      const isFn = (role) => `is${role}`;

      before(async () => {
        c = await deployContract(platformAdmin, contractName);
        if (upgradeable) {
          assert.equal(await c.owner(), ZERO);
          // No public initializer exists: all onlyAdmin calls are rejected while ownerless.
          await expectRevert(async () => c[fn("add", roles[1][0])](randomAddress()), ADMIN_ERR);
          // Install platformAdmin as owner directly in storage (OwnableUpgradeable._owner = slot 51).
          const slot = ethers.toBeHex(51, 32);
          const val = ethers.zeroPadValue(platformAdmin.address, 32);
          await provider.send("hardhat_setStorageAt", [await c.getAddress(), slot, val]);
          assert.equal(await c.owner(), platformAdmin.address);
        } else {
          assert.equal(await c.owner(), platformAdmin.address);
        }
        asAdmin = c.connect(registrar);
        asOutsider = c.connect(outsider);
      });

      for (const [role, label] of roles) {
        it(`${role}: owner can add, emits RoleAdded, and cannot add twice`, async () => {
          const a = randomAddress();
          assert.equal(await c[isFn(role)](a), false);
          const tx = await c[fn("add", role)](a);
          const ev = await eventOf(tx, c, "RoleAdded");
          assert.equal(ev.args[0], a);
          assert.equal(ev.args[1], label);
          assert.equal(await c[isFn(role)](a), true);
          await expectRevert(async () => c[fn("add", role)](a), ALREADY);
        });

        it(`${role}: owner can remove, emits RoleRemoved, and cannot remove twice`, async () => {
          const a = randomAddress();
          await (await c[fn("add", role)](a)).wait();
          const tx = await c[fn("remove", role)](a);
          const ev = await eventOf(tx, c, "RoleRemoved");
          assert.equal(ev.args[0], a);
          assert.equal(ev.args[1], label);
          assert.equal(await c[isFn(role)](a), false);
          await expectRevert(async () => c[fn("remove", role)](a), MISSING);
        });

        it(`${role}: non-admin cannot add or remove`, async () => {
          const a = randomAddress();
          await expectRevert(async () => asOutsider[fn("add", role)](a), ADMIN_ERR);
          await (await c[fn("add", role)](a)).wait();
          await expectRevert(async () => asOutsider[fn("remove", role)](a), ADMIN_ERR);
        });

        it(`${role}: zero address is rejected`, async () => {
          await expectRevert(async () => c[fn("add", role)](ZERO), ZERO_ERR);
          await expectRevert(async () => c[isFn(role)](ZERO), ZERO_ERR);
          await expectRevert(async () => c[fn("remove", role)](ZERO), ZERO_ERR);
        });
      }

      it("an admin-role holder (non-owner) can manage roles until revoked", async () => {
        const adminRole = roles[0][0];
        const other1 = randomAddress();
        await (await c[fn("add", adminRole)](registrar.address)).wait();
        assert.equal(await c[isFn(adminRole)](registrar.address), true);
        // exercise every role as delegated admin
        for (const [role] of roles.slice(1)) {
          await (await asAdmin[fn("add", role)](other1)).wait();
          assert.equal(await c[isFn(role)](other1), true);
          await (await asAdmin[fn("remove", role)](other1)).wait();
          assert.equal(await c[isFn(role)](other1), false);
        }
        await (await c[fn("remove", adminRole)](registrar.address)).wait();
        await expectRevert(async () => asAdmin[fn("add", roles[1][0])](other1), ADMIN_ERR);
      });

      it("roles are independent of one another", async () => {
        const a = randomAddress();
        await (await c[fn("add", roles[1][0])](a)).wait();
        for (const [role] of roles.filter((r) => r[0] !== roles[1][0])) {
          assert.equal(await c[isFn(role)](a), false);
        }
      });

      it("ownership transfer moves admin rights to the new owner", async () => {
        const fresh = await deployContract(platformAdmin, contractName);
        if (upgradeable) {
          const slot = ethers.toBeHex(51, 32);
          await provider.send("hardhat_setStorageAt", [
            await fresh.getAddress(),
            slot,
            ethers.zeroPadValue(platformAdmin.address, 32),
          ]);
        }
        await (await fresh.transferOwnership(aurora.address)).wait();
        const a = randomAddress();
        await expectRevert(async () => fresh[fn("add", roles[1][0])](a), ADMIN_ERR);
        await (await fresh.connect(aurora)[fn("add", roles[1][0])](a)).wait();
        assert.equal(await fresh[isFn(roles[1][0])](a), true);
      });
    });
  }

  rolesSuite("AgentRoles", "AgentRoles", AGENT_ROLES, "agent", false);
  rolesSuite("OwnerRoles", "OwnerRoles", OWNER_ROLES, "owner", false);
  rolesSuite("AgentRolesUpgradeable", "AgentRolesUpgradeable", AGENT_ROLES, "agent", true);
  rolesSuite("OwnerRolesUpgradeable", "OwnerRolesUpgradeable", OWNER_ROLES, "owner", true);

  // ═══════════════════════════════════════════════════════════════════
  //  AgentManager
  // ═══════════════════════════════════════════════════════════════════

  describe("AgentManager", () => {
    let d, mgr, asOp;
    let u1, u2, u3;
    const ids = {}; // role -> { good, keyless }
    let noRoleId;
    const ROLE_ADD = {
      TransferManager: "addTransferManager",
      Freezer: "addFreezer",
      SupplyModifier: "addSupplyModifier",
      RecoveryAgent: "addRecoveryAgent",
      WhiteListManager: "addWhiteListManager",
    };

    before(async () => {
      d = await newDeal();
      mgr = await deployContract(platformAdmin, "AgentManager", d.addrs.token);
      asOp = mgr.connect(op);
      // Make the manager an agent of the token and the identity registry (deal owner = platformAdmin)
      await (await d.token.addAgent(await mgr.getAddress())).wait();
      await (await d.ir.addAgent(await mgr.getAddress())).wait();
      if (await d.token.paused()) await (await d.token.connect(bndSafe).unpause()).wait();

      u1 = randomAddress();
      u2 = randomAddress();
      u3 = randomAddress();
      for (const u of [u1, u2, u3]) {
        await (await d.ir.connect(registrar).registerIdentity(u, randomAddress(), 250)).wait();
      }

      for (const [role, addFn] of Object.entries(ROLE_ADD)) {
        const good = await newIdentity(op);
        const keyless = await newIdentity(other);
        await (await mgr[addFn](good)).wait();
        await (await mgr[addFn](keyless)).wait();
        ids[role] = { good, keyless };
      }
      noRoleId = await newIdentity(op);
    });

    it("stores the managed token and owner", async () => {
      assert.equal(await mgr.token(), d.addrs.token);
      assert.equal(await mgr.owner(), platformAdmin.address);
    });

    // [name, role, call(mgr, id)]
    const entries = () => [
      ["callForcedTransfer", "TransferManager", (m, id) => m.callForcedTransfer(u1, u2, 1, id)],
      ["callBatchForcedTransfer", "TransferManager", (m, id) => m.callBatchForcedTransfer([u1], [u2], [1], id)],
      ["callPause", "Freezer", (m, id) => m.callPause(id)],
      ["callUnpause", "Freezer", (m, id) => m.callUnpause(id)],
      ["callMint", "SupplyModifier", (m, id) => m.callMint(u1, 1, id)],
      ["callBatchMint", "SupplyModifier", (m, id) => m.callBatchMint([u1], [1], id)],
      ["callBurn", "SupplyModifier", (m, id) => m.callBurn(u1, 1, id)],
      ["callBatchBurn", "SupplyModifier", (m, id) => m.callBatchBurn([u1], [1], id)],
      ["callSetAddressFrozen", "Freezer", (m, id) => m.callSetAddressFrozen(u1, true, id)],
      ["callBatchSetAddressFrozen", "Freezer", (m, id) => m.callBatchSetAddressFrozen([u1], [true], id)],
      ["callFreezePartialTokens", "Freezer", (m, id) => m.callFreezePartialTokens(u1, 1, id)],
      ["callBatchFreezePartialTokens", "Freezer", (m, id) => m.callBatchFreezePartialTokens([u1], [1], id)],
      ["callUnfreezePartialTokens", "Freezer", (m, id) => m.callUnfreezePartialTokens(u1, 1, id)],
      ["callBatchUnfreezePartialTokens", "Freezer", (m, id) => m.callBatchUnfreezePartialTokens([u1], [1], id)],
      ["callRecoveryAddress", "RecoveryAgent", (m, id) => m.callRecoveryAddress(u1, u2, randomAddress(), id)],
      ["callRegisterIdentity", "WhiteListManager", (m, id) => m.callRegisterIdentity(randomAddress(), randomAddress(), 1, id)],
      ["callUpdateIdentity", "WhiteListManager", (m, id) => m.callUpdateIdentity(u1, randomAddress(), id)],
      ["callUpdateCountry", "WhiteListManager", (m, id) => m.callUpdateCountry(u1, 1, id)],
      ["callDeleteIdentity", "WhiteListManager", (m, id) => m.callDeleteIdentity(u1, id)],
    ];

    for (const [name, role, call] of entries()) {
      it(`${name}: reverts when the onchainID does not hold the role`, async () => {
        await expectRevert(async () => call(asOp, noRoleId));
      });
      it(`${name}: reverts when sender has no key on the role-holding onchainID`, async () => {
        await expectRevert(async () => call(asOp, ids[role].keyless));
      });
    }

    it("role-gate revert reasons are specific per role", async () => {
      await expectRevert(async () => asOp.callForcedTransfer(u1, u2, 1, noRoleId), "Sender is NOT Transfer Manager");
      await expectRevert(async () => asOp.callPause(noRoleId), "Sender is NOT Freezer");
      await expectRevert(async () => asOp.callMint(u1, 1, noRoleId), "Sender is NOT Supply Modifier");
      await expectRevert(async () => asOp.callRecoveryAddress(u1, u2, u3, noRoleId), "Sender is NOT Recovery Agent");
      await expectRevert(async () => asOp.callDeleteIdentity(u1, noRoleId), "Sender is NOT WhiteList Manager");
      await expectRevert(async () => asOp.callMint(u1, 1, ids.SupplyModifier.keyless), "Sender is NOT Supply Modifier");
    });

    it("SupplyModifier: mint, batchMint, burn, batchBurn", async () => {
      const id = ids.SupplyModifier.good;
      await (await asOp.callMint(u1, 1000, id)).wait();
      assert.equal(await d.token.balanceOf(u1), 1000n);
      await (await asOp.callBatchMint([u2, u3], [100, 200], id)).wait();
      assert.equal(await d.token.balanceOf(u2), 100n);
      assert.equal(await d.token.balanceOf(u3), 200n);
      await (await asOp.callBurn(u1, 5, id)).wait();
      assert.equal(await d.token.balanceOf(u1), 995n);
      await (await asOp.callBatchBurn([u2, u3], [1, 2], id)).wait();
      assert.equal(await d.token.balanceOf(u2), 99n);
      assert.equal(await d.token.balanceOf(u3), 198n);
    });

    it("TransferManager: forcedTransfer and batchForcedTransfer", async () => {
      const id = ids.TransferManager.good;
      await (await asOp.callForcedTransfer(u1, u2, 100, id)).wait();
      assert.equal(await d.token.balanceOf(u1), 895n);
      assert.equal(await d.token.balanceOf(u2), 199n);
      await (await asOp.callBatchForcedTransfer([u1, u1], [u2, u3], [10, 20], id)).wait();
      assert.equal(await d.token.balanceOf(u1), 865n);
      assert.equal(await d.token.balanceOf(u2), 209n);
      assert.equal(await d.token.balanceOf(u3), 218n);
    });

    it("Freezer: pause / unpause", async () => {
      const id = ids.Freezer.good;
      await (await asOp.callPause(id)).wait();
      assert.equal(await d.token.paused(), true);
      await (await asOp.callUnpause(id)).wait();
      assert.equal(await d.token.paused(), false);
    });

    it("Freezer: address freezing, single and batch", async () => {
      const id = ids.Freezer.good;
      await (await asOp.callSetAddressFrozen(u3, true, id)).wait();
      assert.equal(await d.token.isFrozen(u3), true);
      await (await asOp.callBatchSetAddressFrozen([u3, u2], [false, true], id)).wait();
      assert.equal(await d.token.isFrozen(u3), false);
      assert.equal(await d.token.isFrozen(u2), true);
      await (await asOp.callSetAddressFrozen(u2, false, id)).wait();
      assert.equal(await d.token.isFrozen(u2), false);
    });

    it("Freezer: partial freeze / unfreeze, single and batch", async () => {
      const id = ids.Freezer.good;
      await (await asOp.callFreezePartialTokens(u1, 10, id)).wait();
      assert.equal(await d.token.getFrozenTokens(u1), 10n);
      await (await asOp.callBatchFreezePartialTokens([u1, u2], [5, 7], id)).wait();
      assert.equal(await d.token.getFrozenTokens(u1), 15n);
      assert.equal(await d.token.getFrozenTokens(u2), 7n);
      await (await asOp.callUnfreezePartialTokens(u1, 3, id)).wait();
      assert.equal(await d.token.getFrozenTokens(u1), 12n);
      await (await asOp.callBatchUnfreezePartialTokens([u1, u2], [12, 7], id)).wait();
      assert.equal(await d.token.getFrozenTokens(u1), 0n);
      assert.equal(await d.token.getFrozenTokens(u2), 0n);
    });

    it("WhiteListManager: register, update, updateCountry, delete identity", async () => {
      const id = ids.WhiteListManager.good;
      const user = randomAddress();
      const idA = randomAddress();
      const idB = randomAddress();
      await (await asOp.callRegisterIdentity(user, idA, 42, id)).wait();
      assert.equal(await d.ir.contains(user), true);
      assert.equal(await d.ir.identity(user), idA);
      assert.equal(await d.ir.investorCountry(user), 42n);
      await (await asOp.callUpdateIdentity(user, idB, id)).wait();
      assert.equal(await d.ir.identity(user), idB);
      await (await asOp.callUpdateCountry(user, 99, id)).wait();
      assert.equal(await d.ir.investorCountry(user), 99n);
      await (await asOp.callDeleteIdentity(user, id)).wait();
      assert.equal(await d.ir.contains(user), false);
    });

    it("RecoveryAgent: recovers tokens to a new wallet", async () => {
      const lost = randomAddress();
      const newWallet = randomAddress();
      const investorId = await newIdentity(newWallet); // new wallet is a management key
      await (await d.ir.connect(registrar).registerIdentity(lost, investorId, 250)).wait();
      await (await asOp.callMint(lost, 50, ids.SupplyModifier.good)).wait();
      await (await asOp.callRecoveryAddress(lost, newWallet, investorId, ids.RecoveryAgent.good)).wait();
      assert.equal(await d.token.balanceOf(newWallet), 50n);
      assert.equal(await d.token.balanceOf(lost), 0n);
      assert.equal(await d.ir.contains(lost), false);
    });

    it("role removal revokes access", async () => {
      await (await mgr.removeFreezer(ids.Freezer.good)).wait();
      await expectRevert(async () => asOp.callPause(ids.Freezer.good), "Sender is NOT Freezer");
    });

    it("manager without agent rights on the token cannot complete calls", async () => {
      const m2 = await deployContract(platformAdmin, "AgentManager", d.addrs.token);
      const id = await newIdentity(op);
      await (await m2.addSupplyModifier(id)).wait();
      await expectRevert(async () => m2.connect(op).callMint(u1, 1, id));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  OwnerManager
  // ═══════════════════════════════════════════════════════════════════

  describe("OwnerManager", () => {
    let d, mgr, asOp, mgrAddr;
    const ids = {};
    let noRoleId;
    const ROLE_ADD = {
      RegistryAddressSetter: "addRegistryAddressSetter",
      ComplianceSetter: "addComplianceSetter",
      ComplianceManager: "addComplianceManager",
      TokenInfoManager: "addTokenInfoManager",
      IssuersRegistryManager: "addIssuersRegistryManager",
      ClaimRegistryManager: "addClaimRegistryManager",
    };

    before(async () => {
      d = await newDeal();
      mgr = await deployContract(platformAdmin, "OwnerManager", d.addrs.token);
      mgrAddr = await mgr.getAddress();
      asOp = mgr.connect(op);
      for (const c of [d.token, d.ir, d.tir, d.ctr, d.mc]) {
        await (await c.transferOwnership(mgrAddr)).wait();
      }
      for (const [role, addFn] of Object.entries(ROLE_ADD)) {
        const good = await newIdentity(op);
        const keyless = await newIdentity(other);
        await (await mgr[addFn](good)).wait();
        await (await mgr[addFn](keyless)).wait();
        ids[role] = { good, keyless };
      }
      noRoleId = await newIdentity(op);
    });

    it("stores the managed token and is owner of the deal contracts", async () => {
      assert.equal(await mgr.token(), d.addrs.token);
      for (const c of [d.token, d.ir, d.tir, d.ctr, d.mc]) assert.equal(await c.owner(), mgrAddr);
    });

    const newIR = randomAddress();
    const issuer = randomAddress();
    const entries = () => [
      ["callSetIdentityRegistry", "RegistryAddressSetter", (m, id) => m.callSetIdentityRegistry(newIR, id)],
      ["callSetCompliance", "ComplianceSetter", (m, id) => m.callSetCompliance(newIR, id)],
      ["callComplianceFunction", "ComplianceManager", (m, id) => m.callComplianceFunction("0x12345678", id)],
      ["callSetTokenName", "TokenInfoManager", (m, id) => m.callSetTokenName("x", id)],
      ["callSetTokenSymbol", "TokenInfoManager", (m, id) => m.callSetTokenSymbol("x", id)],
      ["callSetTokenOnchainID", "TokenInfoManager", (m, id) => m.callSetTokenOnchainID(newIR, id)],
      ["callSetClaimTopicsRegistry", "RegistryAddressSetter", (m, id) => m.callSetClaimTopicsRegistry(newIR, id)],
      ["callSetTrustedIssuersRegistry", "RegistryAddressSetter", (m, id) => m.callSetTrustedIssuersRegistry(newIR, id)],
      ["callAddTrustedIssuer", "IssuersRegistryManager", (m, id) => m.callAddTrustedIssuer(issuer, [1], id)],
      ["callRemoveTrustedIssuer", "IssuersRegistryManager", (m, id) => m.callRemoveTrustedIssuer(issuer, id)],
      ["callUpdateIssuerClaimTopics", "IssuersRegistryManager", (m, id) => m.callUpdateIssuerClaimTopics(issuer, [2], id)],
      ["callAddClaimTopic", "ClaimRegistryManager", (m, id) => m.callAddClaimTopic(1, id)],
      ["callRemoveClaimTopic", "ClaimRegistryManager", (m, id) => m.callRemoveClaimTopic(1, id)],
    ];

    for (const [name, role, call] of entries()) {
      it(`${name}: reverts when the onchainID does not hold the role`, async () => {
        await expectRevert(async () => call(asOp, noRoleId));
      });
      it(`${name}: reverts when sender has no key on the role-holding onchainID`, async () => {
        await expectRevert(async () => call(asOp, ids[role].keyless));
      });
    }

    it("role-gate revert reasons are specific per role", async () => {
      const r = (f, m) => expectRevert(f, m);
      await r(async () => asOp.callSetIdentityRegistry(newIR, noRoleId), "Sender is NOT Registry Address Setter");
      await r(async () => asOp.callSetCompliance(newIR, noRoleId), "Sender is NOT Compliance Setter");
      await r(async () => asOp.callComplianceFunction("0x", noRoleId), "Sender is NOT Compliance Manager");
      await r(async () => asOp.callSetTokenName("x", noRoleId), "Sender is NOT Token Information Manager");
      await r(async () => asOp.callAddTrustedIssuer(issuer, [1], noRoleId), "Sender is NOT IssuersRegistryManager");
      await r(async () => asOp.callAddClaimTopic(1, noRoleId), "Sender is NOT ClaimRegistryManager");
    });

    it("onlyAdmin ownership/agent functions reject non-admins", async () => {
      const a = randomAddress();
      for (const f of [
        "callTransferOwnershipOnTokenContract",
        "callTransferOwnershipOnIdentityRegistryContract",
        "callTransferOwnershipOnComplianceContract",
        "callTransferOwnershipOnClaimTopicsRegistryContract",
        "callTransferOwnershipOnIssuersRegistryContract",
        "callAddAgentOnTokenContract",
        "callRemoveAgentOnTokenContract",
        "callAddAgentOnIdentityRegistryContract",
        "callRemoveAgentOnIdentityRegistryContract",
      ]) {
        await expectRevert(async () => mgr.connect(outsider)[f](a), ADMIN_ERR);
      }
    });

    it("RegistryAddressSetter: sets IR, CTR and TIR addresses", async () => {
      const id = ids.RegistryAddressSetter.good;
      const newTir = await deployContract(deployer, "TrustedIssuersRegistry");
      const newCtr = await deployContract(deployer, "ClaimTopicsRegistry");
      await (await asOp.callSetClaimTopicsRegistry(await newCtr.getAddress(), id)).wait();
      assert.equal(await d.ir.topicsRegistry(), await newCtr.getAddress());
      await (await asOp.callSetTrustedIssuersRegistry(await newTir.getAddress(), id)).wait();
      assert.equal(await d.ir.issuersRegistry(), await newTir.getAddress());
      // restore the originals
      await (await asOp.callSetClaimTopicsRegistry(d.addrs.ctr, id)).wait();
      await (await asOp.callSetTrustedIssuersRegistry(d.addrs.tir, id)).wait();
      assert.equal(await d.ir.topicsRegistry(), d.addrs.ctr);
      assert.equal(await d.ir.issuersRegistry(), d.addrs.tir);
      // set the token's IR to itself again (token owner = manager)
      await (await asOp.callSetIdentityRegistry(d.addrs.ir, id)).wait();
      assert.equal(await d.token.identityRegistry(), d.addrs.ir);
    });

    it("ComplianceSetter: re-sets the compliance contract", async () => {
      await (await asOp.callSetCompliance(d.addrs.mc, ids.ComplianceSetter.good)).wait();
      assert.equal(await d.token.compliance(), d.addrs.mc);
    });

    it("TokenInfoManager: name, symbol, onchainID", async () => {
      const id = ids.TokenInfoManager.good;
      await (await asOp.callSetTokenName("Renamed Bond", id)).wait();
      assert.equal(await d.token.name(), "Renamed Bond");
      await (await asOp.callSetTokenSymbol("RNB", id)).wait();
      assert.equal(await d.token.symbol(), "RNB");
      const oid = randomAddress();
      await (await asOp.callSetTokenOnchainID(oid, id)).wait();
      assert.equal(await d.token.onchainID(), oid);
    });

    it("IssuersRegistryManager: add, update topics, remove trusted issuer", async () => {
      const id = ids.IssuersRegistryManager.good;
      await (await asOp.callAddTrustedIssuer(issuer, [1, 2], id)).wait();
      assert.equal(await d.tir.isTrustedIssuer(issuer), true);
      await (await asOp.callUpdateIssuerClaimTopics(issuer, [3], id)).wait();
      assert.deepEqual((await d.tir.getTrustedIssuerClaimTopics(issuer)).map(BigInt), [3n]);
      await (await asOp.callRemoveTrustedIssuer(issuer, id)).wait();
      assert.equal(await d.tir.isTrustedIssuer(issuer), false);
    });

    it("ClaimRegistryManager: add and remove claim topic", async () => {
      const id = ids.ClaimRegistryManager.good;
      await (await asOp.callAddClaimTopic(7, id)).wait();
      assert.deepEqual((await d.ctr.getClaimTopics()).map(BigInt), [7n]);
      await (await asOp.callRemoveClaimTopic(7, id)).wait();
      assert.deepEqual((await d.ctr.getClaimTopics()).map(BigInt), []);
    });

    it("ComplianceManager: forwards owner-only calls and emits ComplianceInteraction", async () => {
      const id = ids.ComplianceManager.good;
      const sl = await platform.supplyLimitModule.getAddress();
      assert.deepEqual((await d.mc.getModules()).map((x) => x.toLowerCase()), [sl.toLowerCase()]);
      const data = d.mc.interface.encodeFunctionData("removeModule", [sl]);
      const tx = await asOp.callComplianceFunction(data, id);
      const ev = await eventOf(tx, mgr, "ComplianceInteraction");
      assert.equal(ev.args[0], d.addrs.mc);
      assert.equal(ev.args[1], data.slice(0, 10));
      assert.equal((await d.mc.getModules()).length, 0);
    });

    it("ComplianceManager: bubbles up reverts from the compliance contract", async () => {
      const data = d.mc.interface.encodeFunctionData("removeModule", [randomAddress()]);
      await expectRevert(async () => asOp.callComplianceFunction(data, ids.ComplianceManager.good));
    });

    it("admin (owner or OwnerAdmin) can add and remove agents on token and IR", async () => {
      const a = randomAddress();
      const b = randomAddress();
      await (await mgr.callAddAgentOnTokenContract(a)).wait();
      assert.equal(await d.token.isAgent(a), true);
      await (await mgr.callRemoveAgentOnTokenContract(a)).wait();
      assert.equal(await d.token.isAgent(a), false);
      // OwnerAdmin delegate (non-owner) path
      await (await mgr.addOwnerAdmin(registrar.address)).wait();
      const asAdm = mgr.connect(registrar);
      await (await asAdm.callAddAgentOnIdentityRegistryContract(b)).wait();
      assert.equal(await d.ir.isAgent(b), true);
      await (await asAdm.callRemoveAgentOnIdentityRegistryContract(b)).wait();
      assert.equal(await d.ir.isAgent(b), false);
    });

    it("admin can transfer ownership of TIR, CTR and compliance", async () => {
      await (await mgr.callTransferOwnershipOnIssuersRegistryContract(aurora.address)).wait();
      assert.equal(await d.tir.owner(), aurora.address);
      await (await mgr.callTransferOwnershipOnClaimTopicsRegistryContract(northbridge.address)).wait();
      assert.equal(await d.ctr.owner(), northbridge.address);
      await (await mgr.callTransferOwnershipOnComplianceContract(meridian.address)).wait();
      assert.equal(await d.mc.owner(), meridian.address);
    });

    it("ComplianceManager: calldata shorter than 4 bytes yields a zero selector", async () => {
      // Point the token at a contract that accepts any calldata (runtime code = STOP).
      const stub = randomAddress();
      await provider.send("hardhat_setCode", [stub, "0x00"]);
      await (await asOp.callSetCompliance(stub, ids.ComplianceSetter.good)).wait();
      assert.equal(await d.token.compliance(), stub);
      const id = ids.ComplianceManager.good;
      for (const [data, sel] of [
        ["0x", "0x00000000"],
        ["0x1234", "0x00000000"],
        ["0xdeadbeef", "0xdeadbeef"],
        ["0xdeadbeef0102", "0xdeadbeef"],
      ]) {
        const ev = await eventOf(await asOp.callComplianceFunction(data, id), mgr, "ComplianceInteraction");
        assert.equal(ev.args[0], stub);
        assert.equal(ev.args[1], sel);
      }
    });

    it("admin can transfer ownership of the IR and then the token", async () => {
      await (await mgr.callTransferOwnershipOnIdentityRegistryContract(aurora.address)).wait();
      assert.equal(await d.ir.owner(), aurora.address);
      await (await mgr.callTransferOwnershipOnTokenContract(northbridge.address)).wait();
      assert.equal(await d.token.owner(), northbridge.address);
      // manager no longer owns the token, so forwarded owner calls fail
      await expectRevert(async () => asOp.callSetTokenName("nope", ids.TokenInfoManager.good));
    });
  });
});
