import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  setupProvider,
  getSigners,
  deployPlatform,
  deployDeal,
  deployContract,
  getContractAt,
} from "./helpers.js";

const AGENT_ERR = "AgentRole: caller does not have the Agent role";
const OWNER_ERR = "Ownable: caller is not the owner";
const ZERO_ERR = "invalid argument - zero address";

/** Assert that `fn` reverts, and (optionally) that the revert text contains `reason`. */
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
    assert.ok(
      text.includes(reason),
      `expected revert reason "${reason}", got: ${text}`
    );
  }
}

/** Returns the parsed log named `name` emitted by `contract` in `tx`, or undefined. */
async function findEvent(tx, contract, name) {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== (await contract.getAddress()).toLowerCase()) continue;
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === name) return parsed;
    } catch {
      /* not this event */
    }
  }
  return undefined;
}

describe("IdentityRegistry", () => {
  let conn, provider;
  let deployer, platformAdmin, registrar, bndSafe, outsider, aurora, northbridge;
  let platform;
  let deal;
  let ir, irAsRegistrar, irAsAdmin, irAsOutsider;
  let id1, id2; // mock ONCHAINID contracts
  let user1, user2;

  // Every test gets a clean registry: wallets are unique per test via a counter.
  let counter = 0;
  const freshWallet = () => ethers.Wallet.createRandom().address;

  before(async () => {
    ({ conn, provider } = await setupProvider());
    const s = await getSigners(provider);
    ({ deployer, platformAdmin, registrar, bndSafe, outsider, aurora, northbridge } = s);

    platform = await deployPlatform(deployer);
    deal = await deployDeal(
      platform.gateway,
      deployer,
      platformAdmin,
      registrar,
      bndSafe,
      platform.supplyLimitModule
    );

    ir = await getContractAt("IdentityRegistry", deal.ir, deployer);
    irAsRegistrar = ir.connect(registrar);
    irAsAdmin = ir.connect(platformAdmin);
    irAsOutsider = ir.connect(outsider);

    id1 = await deployContract(deployer, "MockIdentityForIR");
    id2 = await deployContract(deployer, "MockIdentityForIR");
  });

  after(async () => {
    // shared connection: closed by process exit
  });

  // Fresh user addresses so tests never collide on "address stored already".
  const newUsers = () => {
    counter++;
    user1 = freshWallet();
    user2 = freshWallet();
  };

  const register = async (user, identity, country) => {
    const tx = await irAsRegistrar.registerIdentity(user, await identity.getAddress(), country);
    await tx.wait();
  };

  // ═══════════════════════════════════════════════════════════════════
  //  init / wiring
  // ═══════════════════════════════════════════════════════════════════

  describe("init and wiring", () => {
    it("sets the three registries", async () => {
      assert.equal(await ir.topicsRegistry(), deal.ctr);
      assert.equal(await ir.issuersRegistry(), deal.tir);
      assert.equal(await ir.identityStorage(), deal.irs);
    });

    it("owner is platformAdmin", async () => {
      assert.equal(await ir.owner(), platformAdmin.address);
    });

    it("cannot be initialised twice", async () => {
      await expectRevert(
        async () => ir.init(deal.tir, deal.ctr, deal.irs),
        "already initialized"
      );
    });

    it("reverts on a zero address argument", async () => {
      const impl = await deployContract(deployer, "IdentityRegistry");
      await expectRevert(async () => impl.init(ethers.ZeroAddress, deal.ctr, deal.irs), ZERO_ERR);
      await expectRevert(async () => impl.init(deal.tir, ethers.ZeroAddress, deal.irs), ZERO_ERR);
      await expectRevert(async () => impl.init(deal.tir, deal.ctr, ethers.ZeroAddress), ZERO_ERR);
    });

    it("emits the three Set events on init", async () => {
      const impl = await deployContract(deployer, "IdentityRegistry");
      const tx = await impl.init(deal.tir, deal.ctr, deal.irs);
      assert.equal((await findEvent(tx, impl, "ClaimTopicsRegistrySet")).args[0], deal.ctr);
      assert.equal((await findEvent(tx, impl, "TrustedIssuersRegistrySet")).args[0], deal.tir);
      assert.equal((await findEvent(tx, impl, "IdentityStorageSet")).args[0], deal.irs);
    });

    it("implementation contract can be initialised directly (not locked)", async () => {
      // Documents current behaviour: no _disableInitializers in the constructor.
      // If that is hardened later, this test should flip to expecting a revert.
      const impl = await deployContract(deployer, "IdentityRegistry");
      const tx = await impl.init(deal.tir, deal.ctr, deal.irs);
      await tx.wait();
      assert.equal(await impl.owner(), deployer.address);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  registerIdentity
  // ═══════════════════════════════════════════════════════════════════

  describe("registerIdentity", () => {
    before(newUsers);

    it("stores identity and country", async () => {
      newUsers();
      await register(user1, id1, 356);
      assert.equal(await ir.identity(user1), await id1.getAddress());
      assert.equal(await ir.investorCountry(user1), 356n);
      assert.equal(await ir.contains(user1), true);
    });

    it("emits IdentityRegistered", async () => {
      newUsers();
      const tx = await irAsRegistrar.registerIdentity(user1, await id1.getAddress(), 356);
      const ev = await findEvent(tx, ir, "IdentityRegistered");
      assert.ok(ev, "IdentityRegistered not emitted");
      assert.equal(ev.args[0], user1);
      assert.equal(ev.args[1], await id1.getAddress());
    });

    it("reverts for a non-agent", async () => {
      newUsers();
      await expectRevert(
        async () => irAsOutsider.registerIdentity(user1, await id1.getAddress(), 356),
        AGENT_ERR
      );
    });

    it("reverts for the owner (owner is not automatically an agent)", async () => {
      newUsers();
      await expectRevert(
        async () => irAsAdmin.registerIdentity(user1, await id1.getAddress(), 356),
        AGENT_ERR
      );
    });

    it("reverts on a duplicate registration", async () => {
      newUsers();
      await register(user1, id1, 356);
      await expectRevert(
        async () => irAsRegistrar.registerIdentity(user1, await id2.getAddress(), 356),
        "address stored already"
      );
    });

    it("reverts on a zero user address", async () => {
      await expectRevert(
        async () => irAsRegistrar.registerIdentity(ethers.ZeroAddress, await id1.getAddress(), 356),
        ZERO_ERR
      );
    });

    it("reverts on a zero identity address", async () => {
      newUsers();
      await expectRevert(
        async () => irAsRegistrar.registerIdentity(user1, ethers.ZeroAddress, 356),
        ZERO_ERR
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  batchRegisterIdentity
  //  (no onlyAgent on the batch function itself; protection comes from the
  //   onlyAgent on registerIdentity, which it calls internally)
  // ═══════════════════════════════════════════════════════════════════

  describe("batchRegisterIdentity", () => {
    it("registers every entry", async () => {
      newUsers();
      const tx = await irAsRegistrar.batchRegisterIdentity(
        [user1, user2],
        [await id1.getAddress(), await id2.getAddress()],
        [356, 840]
      );
      await tx.wait();
      assert.equal(await ir.identity(user1), await id1.getAddress());
      assert.equal(await ir.identity(user2), await id2.getAddress());
      assert.equal(await ir.investorCountry(user1), 356n);
      assert.equal(await ir.investorCountry(user2), 840n);
    });

    it("reverts for a non-agent with a non-empty batch", async () => {
      newUsers();
      await expectRevert(
        async () =>
          irAsOutsider.batchRegisterIdentity([user1], [await id1.getAddress()], [356]),
        AGENT_ERR
      );
    });

    it("reverts for the owner with a non-empty batch", async () => {
      newUsers();
      await expectRevert(
        async () =>
          irAsAdmin.batchRegisterIdentity([user1], [await id1.getAddress()], [356]),
        AGENT_ERR
      );
    });

    it("empty arrays are a no-op for an agent", async () => {
      const tx = await irAsRegistrar.batchRegisterIdentity([], [], []);
      await tx.wait();
    });

    it("empty arrays from a non-agent are also a no-op (no onlyAgent on batch)", async () => {
      // Documents current behaviour; flips to a revert if onlyAgent is re-added.
      const tx = await irAsOutsider.batchRegisterIdentity([], [], []);
      await tx.wait();
    });

    it("reverts on mismatched array lengths", async () => {
      newUsers();
      await expectRevert(async () =>
        irAsRegistrar.batchRegisterIdentity(
          [user1, user2],
          [await id1.getAddress()],
          [356, 840]
        )
      );
    });

    it("is atomic: one bad entry rolls back the whole batch", async () => {
      newUsers();
      await register(user2, id2, 840);
      await expectRevert(
        async () =>
          irAsRegistrar.batchRegisterIdentity(
            [user1, user2], // user2 already registered
            [await id1.getAddress(), await id2.getAddress()],
            [356, 840]
          ),
        "address stored already"
      );
      assert.equal(await ir.contains(user1), false, "user1 should have been rolled back");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  updateIdentity / updateCountry / deleteIdentity
  // ═══════════════════════════════════════════════════════════════════

  describe("updateIdentity", () => {
    it("replaces the identity and emits IdentityUpdated", async () => {
      newUsers();
      await register(user1, id1, 356);
      const tx = await irAsRegistrar.updateIdentity(user1, await id2.getAddress());
      const ev = await findEvent(tx, ir, "IdentityUpdated");
      assert.equal(ev.args[0], await id1.getAddress());
      assert.equal(ev.args[1], await id2.getAddress());
      assert.equal(await ir.identity(user1), await id2.getAddress());
    });

    it("reverts if not registered", async () => {
      newUsers();
      await expectRevert(
        async () => irAsRegistrar.updateIdentity(user1, await id2.getAddress()),
        "address not stored yet"
      );
    });

    it("reverts for a non-agent", async () => {
      newUsers();
      await register(user1, id1, 356);
      await expectRevert(
        async () => irAsOutsider.updateIdentity(user1, await id2.getAddress()),
        AGENT_ERR
      );
    });
  });

  describe("updateCountry", () => {
    it("changes the country and emits CountryUpdated", async () => {
      newUsers();
      await register(user1, id1, 356);
      const tx = await irAsRegistrar.updateCountry(user1, 840);
      const ev = await findEvent(tx, ir, "CountryUpdated");
      assert.equal(ev.args[0], user1);
      assert.equal(ev.args[1], 840n);
      assert.equal(await ir.investorCountry(user1), 840n);
    });

    it("reverts if not registered", async () => {
      newUsers();
      await expectRevert(async () => irAsRegistrar.updateCountry(user1, 840), "address not stored yet");
    });

    it("reverts for a non-agent", async () => {
      newUsers();
      await register(user1, id1, 356);
      await expectRevert(async () => irAsOutsider.updateCountry(user1, 840), AGENT_ERR);
    });
  });

  describe("deleteIdentity", () => {
    it("removes the entry and emits IdentityRemoved", async () => {
      newUsers();
      await register(user1, id1, 356);
      const tx = await irAsRegistrar.deleteIdentity(user1);
      const ev = await findEvent(tx, ir, "IdentityRemoved");
      assert.equal(ev.args[0], user1);
      assert.equal(ev.args[1], await id1.getAddress());
      assert.equal(await ir.contains(user1), false);
      assert.equal(await ir.identity(user1), ethers.ZeroAddress);
      assert.equal(await ir.investorCountry(user1), 0n);
    });

    it("reverts if not registered", async () => {
      newUsers();
      await expectRevert(async () => irAsRegistrar.deleteIdentity(user1), "address not stored yet");
    });

    it("reverts for a non-agent", async () => {
      newUsers();
      await register(user1, id1, 356);
      await expectRevert(async () => irAsOutsider.deleteIdentity(user1), AGENT_ERR);
    });

    it("allows re-registration after delete", async () => {
      newUsers();
      await register(user1, id1, 356);
      await (await irAsRegistrar.deleteIdentity(user1)).wait();
      await register(user1, id2, 840);
      assert.equal(await ir.identity(user1), await id2.getAddress());
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  owner setters (use throwaway IR instances so the shared deal stays intact)
  // ═══════════════════════════════════════════════════════════════════

  describe("owner setters", () => {
    // A standalone IR owned by `deployer` so we can change its wiring freely.
    let ir2;
    before(async () => {
      ir2 = await deployContract(deployer, "IdentityRegistry");
      await (await ir2.init(deal.tir, deal.ctr, deal.irs)).wait();
    });

    it("setIdentityRegistryStorage: owner only", async () => {
      const addr = freshWallet();
      const tx = await ir2.setIdentityRegistryStorage(addr);
      assert.equal((await findEvent(tx, ir2, "IdentityStorageSet")).args[0], addr);
      assert.equal(await ir2.identityStorage(), addr);
      await expectRevert(async () => ir2.connect(outsider).setIdentityRegistryStorage(addr), OWNER_ERR);
    });

    it("setClaimTopicsRegistry: owner only", async () => {
      const addr = freshWallet();
      const tx = await ir2.setClaimTopicsRegistry(addr);
      assert.equal((await findEvent(tx, ir2, "ClaimTopicsRegistrySet")).args[0], addr);
      assert.equal(await ir2.topicsRegistry(), addr);
      await expectRevert(async () => ir2.connect(outsider).setClaimTopicsRegistry(addr), OWNER_ERR);
    });

    it("setTrustedIssuersRegistry: owner only", async () => {
      const addr = freshWallet();
      const tx = await ir2.setTrustedIssuersRegistry(addr);
      assert.equal((await findEvent(tx, ir2, "TrustedIssuersRegistrySet")).args[0], addr);
      assert.equal(await ir2.issuersRegistry(), addr);
      await expectRevert(async () => ir2.connect(outsider).setTrustedIssuersRegistry(addr), OWNER_ERR);
    });

    it("an agent (non-owner) cannot call the setters", async () => {
      await expectRevert(
        async () => irAsRegistrar.setClaimTopicsRegistry(freshWallet()),
        OWNER_ERR
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  agent management
  // ═══════════════════════════════════════════════════════════════════

  describe("agent management", () => {
    it("addAgent is owner only", async () => {
      const agent = freshWallet();
      await expectRevert(async () => irAsOutsider.addAgent(agent), OWNER_ERR);
      await (await irAsAdmin.addAgent(agent)).wait();
      assert.equal(await ir.isAgent(agent), true);
      await (await irAsAdmin.removeAgent(agent)).wait();
    });

    it("addAgent reverts on zero address", async () => {
      await expectRevert(async () => irAsAdmin.addAgent(ethers.ZeroAddress), ZERO_ERR);
    });

    it("removed agent loses access", async () => {
      // use a different agent than the shared registrar so other tests are unaffected
      await (await irAsAdmin.addAgent(aurora.address)).wait();
      await (await irAsAdmin.removeAgent(aurora.address)).wait();
      assert.equal(await ir.isAgent(aurora.address), false);
      newUsers();
      await expectRevert(
        async () => ir.connect(aurora).registerIdentity(user1, await id1.getAddress(), 356),
        AGENT_ERR
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  isVerified
  //  Uses a dedicated deal so adding claim topics doesn't affect other tests.
  // ═══════════════════════════════════════════════════════════════════

  describe("isVerified", () => {
    let vIr, vCtr, vTir, vIrAgent;
    const TOPIC = 1;

    // Deploy a second deal with a *distinct token name* (salt) for claim tests.
    before(async () => {
      const tokenDetails = {
        owner: platformAdmin.address,
        name: "IR isVerified deal",
        symbol: "IRV",
        decimals: 0,
        irs: ethers.ZeroAddress,
        ONCHAINID: ethers.ZeroAddress,
        irAgents: [registrar.address],
        tokenAgents: [bndSafe.address],
        complianceModules: [],
        complianceSettings: [],
      };
      const claimDetails = { claimTopics: [], issuers: [], issuerClaims: [] };
      const tx = await platform.gateway.deployTREXSuite(tokenDetails, claimDetails);
      const receipt = await tx.wait();
      const factoryIface = platform.factory.interface;
      let d;
      for (const log of receipt.logs) {
        try {
          const p = factoryIface.parseLog({ topics: log.topics, data: log.data });
          if (p && p.name === "TREXSuiteDeployed") {
            d = { ir: p.args[1], tir: p.args[3], ctr: p.args[4] };
            break;
          }
        } catch {
          /* skip */
        }
      }
      vIr = (await getContractAt("IdentityRegistry", d.ir, deployer)).connect(registrar);
      vCtr = (await getContractAt("ClaimTopicsRegistry", d.ctr, deployer)).connect(platformAdmin);
      vTir = (await getContractAt("TrustedIssuersRegistry", d.tir, deployer)).connect(platformAdmin);
    });

    // Each claim test needs its own topic/issuer state, so we reset by using new
    // identities and issuers, and only add the topic once.
    let topicAdded = false;
    const requireTopicOnce = async () => {
      if (!topicAdded) {
        await (await vCtr.addClaimTopic(TOPIC)).wait();
        topicAdded = true;
      }
    };

    it("false when the wallet is not registered", async () => {
      assert.equal(await vIr.isVerified(freshWallet()), false);
    });

    it("true when registered and no claim topics are required", async () => {
      const user = freshWallet();
      await (await vIr.registerIdentity(user, await id1.getAddress(), 356)).wait();
      assert.equal(await vIr.isVerified(user), true);
    });

    it("false when a topic is required but no issuer is trusted for it", async () => {
      await requireTopicOnce();
      const user = freshWallet();
      await (await vIr.registerIdentity(user, await id1.getAddress(), 356)).wait();
      assert.equal(await vIr.isVerified(user), false);
    });

    it("true with a valid claim from a trusted issuer", async () => {
      await requireTopicOnce();
      const issuer = await deployContract(deployer, "MockClaimIssuerForIR");
      await (await vTir.addTrustedIssuer(await issuer.getAddress(), [TOPIC])).wait();
      const identity = await deployContract(deployer, "MockIdentityForIR");
      await (await identity.setClaim(await issuer.getAddress(), TOPIC)).wait();
      const user = freshWallet();
      await (await vIr.registerIdentity(user, await identity.getAddress(), 356)).wait();
      // note: other trusted issuers added by earlier tests also count, but only
      // one valid claim is needed per topic
      assert.equal(await vIr.isVerified(user), true);
    });

    it("false when the identity has no claim from any trusted issuer", async () => {
      await requireTopicOnce();
      const identity = await deployContract(deployer, "MockIdentityForIR"); // no claims
      const user = freshWallet();
      await (await vIr.registerIdentity(user, await identity.getAddress(), 356)).wait();
      assert.equal(await vIr.isVerified(user), false);
    });

    it("false after the identity is deleted", async () => {
      await requireTopicOnce();
      // register a wallet that has a valid claim from a fresh issuer
      const issuer = await deployContract(deployer, "MockClaimIssuerForIR");
      await (await vTir.addTrustedIssuer(await issuer.getAddress(), [TOPIC])).wait();
      const identity = await deployContract(deployer, "MockIdentityForIR");
      await (await identity.setClaim(await issuer.getAddress(), TOPIC)).wait();
      const user = freshWallet();
      await (await vIr.registerIdentity(user, await identity.getAddress(), 356)).wait();
      assert.equal(await vIr.isVerified(user), true);
      await (await vIr.deleteIdentity(user)).wait();
      assert.equal(await vIr.isVerified(user), false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  isVerified: claim validity branches
  //  Each test deploys its own deal (distinct token name => distinct salt) so the
  //  set of trusted issuers is exactly what the test sets up.
  // ═══════════════════════════════════════════════════════════════════

  describe("isVerified: claim validity", () => {
    const TOPIC = 1;

    /** Deploys a fresh deal requiring TOPIC and returns its registries + a funded agent view. */
    async function newClaimDeal(name) {
      const tokenDetails = {
        owner: platformAdmin.address,
        name,
        symbol: "IRC",
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
      let d;
      for (const log of receipt.logs) {
        try {
          const p = platform.factory.interface.parseLog({ topics: log.topics, data: log.data });
          if (p && p.name === "TREXSuiteDeployed") {
            d = { ir: p.args[1], tir: p.args[3], ctr: p.args[4] };
            break;
          }
        } catch {
          /* skip */
        }
      }
      const dIr = (await getContractAt("IdentityRegistry", d.ir, deployer)).connect(registrar);
      const dCtr = (await getContractAt("ClaimTopicsRegistry", d.ctr, deployer)).connect(platformAdmin);
      const dTir = (await getContractAt("TrustedIssuersRegistry", d.tir, deployer)).connect(platformAdmin);
      await (await dCtr.addClaimTopic(TOPIC)).wait();
      return { dIr, dTir };
    }

    /** Trust a new mock issuer for TOPIC and give `identity` a claim from it. */
    async function trustedIssuerWithClaim(dTir, identity) {
      const issuer = await deployContract(deployer, "MockClaimIssuerForIR");
      await (await dTir.addTrustedIssuer(await issuer.getAddress(), [TOPIC])).wait();
      await (await identity.setClaim(await issuer.getAddress(), TOPIC)).wait();
      return issuer;
    }

    it("false when the issuer reports the claim as invalid", async () => {
      const { dIr, dTir } = await newClaimDeal("IR claim invalid");
      const identity = await deployContract(deployer, "MockIdentityForIR");
      const issuer = await trustedIssuerWithClaim(dTir, identity);
      await (await issuer.setValid(false)).wait();

      const user = freshWallet();
      await (await dIr.registerIdentity(user, await identity.getAddress(), 356)).wait();
      assert.equal(await dIr.isVerified(user), false);
    });

    it("false when the issuer's isClaimValid reverts", async () => {
      const { dIr, dTir } = await newClaimDeal("IR issuer reverts");
      const identity = await deployContract(deployer, "MockIdentityForIR");
      const issuer = await trustedIssuerWithClaim(dTir, identity);
      await (await issuer.setRevert(true)).wait();

      const user = freshWallet();
      await (await dIr.registerIdentity(user, await identity.getAddress(), 356)).wait();
      assert.equal(await dIr.isVerified(user), false);
    });

    it("true when a second trusted issuer's valid claim satisfies the topic", async () => {
      const { dIr, dTir } = await newClaimDeal("IR second issuer");
      const identity = await deployContract(deployer, "MockIdentityForIR");
      const bad = await trustedIssuerWithClaim(dTir, identity);
      await (await bad.setValid(false)).wait();
      await trustedIssuerWithClaim(dTir, identity); // second issuer, valid

      const user = freshWallet();
      await (await dIr.registerIdentity(user, await identity.getAddress(), 356)).wait();
      assert.equal(await dIr.isVerified(user), true);
    });

    it("true when the first issuer reverts but a later issuer's claim is valid", async () => {
      const { dIr, dTir } = await newClaimDeal("IR revert then valid");
      const identity = await deployContract(deployer, "MockIdentityForIR");
      const flaky = await trustedIssuerWithClaim(dTir, identity);
      await (await flaky.setRevert(true)).wait();
      await trustedIssuerWithClaim(dTir, identity); // valid

      const user = freshWallet();
      await (await dIr.registerIdentity(user, await identity.getAddress(), 356)).wait();
      assert.equal(await dIr.isVerified(user), true);
    });

    it("false when every trusted issuer's claim is invalid", async () => {
      const { dIr, dTir } = await newClaimDeal("IR all invalid");
      const identity = await deployContract(deployer, "MockIdentityForIR");
      const a = await trustedIssuerWithClaim(dTir, identity);
      const b = await trustedIssuerWithClaim(dTir, identity);
      await (await a.setValid(false)).wait();
      await (await b.setValid(false)).wait();

      const user = freshWallet();
      await (await dIr.registerIdentity(user, await identity.getAddress(), 356)).wait();
      assert.equal(await dIr.isVerified(user), false);
    });
  });
});
