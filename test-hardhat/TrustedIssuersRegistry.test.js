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
  randomAddress,
} from "./helpers.js";

const OWNER_ERR = "Ownable: caller is not the owner";
const ZERO = ethers.ZeroAddress;

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

async function findEvent(tx, contract, name) {
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

/** Deterministic PRNG (mulberry32) so fuzz failures are reproducible from the seed. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("TrustedIssuersRegistry", () => {
  let conn, provider;
  let deployer, platformAdmin, registrar, bndSafe, outsider;
  let platform, deal;

  before(async () => {
    ({ conn, provider } = await setupProvider());
    ({ deployer, platformAdmin, registrar, bndSafe, outsider } = await getSigners(provider));

    platform = await deployPlatform(deployer);
    deal = await deployDeal(
      platform.gateway,
      deployer,
      platformAdmin,
      registrar,
      bndSafe,
      platform.supplyLimitModule
    );
  });

  after(async () => {
    // shared connection: closed by process exit (closing here breaks other test files)
  });

  /** A standalone, initialised registry owned by `deployer`, so each test starts empty. */
  async function freshTir() {
    const tir = await deployContract(deployer, "TrustedIssuersRegistry");
    await (await tir.init()).wait();
    return tir;
  }

  const lc = (a) => a.toLowerCase();
  const addrsOf = (arr) => arr.map((a) => lc(a));
  const issuersOf = async (tir) => addrsOf(await tir.getTrustedIssuers());
  const issuersFor = async (tir, topic) => addrsOf(await tir.getTrustedIssuersForClaimTopic(topic));
  const topicsOf = async (tir, issuer) => (await tir.getTrustedIssuerClaimTopics(issuer)).map(BigInt);
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  // ═══════════════════════════════════════════════════════════════════
  //  init / deal wiring
  // ═══════════════════════════════════════════════════════════════════

  describe("init and deal wiring", () => {
    it("deal TIR proxy is owned by platformAdmin", async () => {
      const tir = await getContractAt("TrustedIssuersRegistry", deal.tir, deployer);
      assert.equal(await tir.owner(), platformAdmin.address);
    });

    it("deal TIR starts with no trusted issuers", async () => {
      const tir = await getContractAt("TrustedIssuersRegistry", deal.tir, deployer);
      assert.deepEqual(await issuersOf(tir), []);
    });

    it("deal TIR is the one wired into the deal's IdentityRegistry", async () => {
      const ir = await getContractAt("IdentityRegistry", deal.ir, deployer);
      assert.equal(await ir.issuersRegistry(), deal.tir);
    });

    it("init sets the caller as owner", async () => {
      const tir = await freshTir();
      assert.equal(await tir.owner(), deployer.address);
    });

    it("cannot be initialised twice", async () => {
      const tir = await freshTir();
      await expectRevert(async () => tir.init(), "already initialized");
    });

    it("deal TIR proxy cannot be re-initialised", async () => {
      const tir = await getContractAt("TrustedIssuersRegistry", deal.tir, deployer);
      await expectRevert(async () => tir.init(), "already initialized");
    });

    it("an uninitialised registry has no owner, so addTrustedIssuer reverts", async () => {
      const tir = await deployContract(deployer, "TrustedIssuersRegistry"); // init() never called
      assert.equal(await tir.owner(), ZERO);
      await expectRevert(async () => tir.addTrustedIssuer(randomAddress(), [1]), OWNER_ERR);
    });

    it("proxy constructor rejects a zero implementation authority", async () => {
      await expectRevert(
        async () => deployContract(deployer, "TrustedIssuersRegistryProxy", ZERO),
        "invalid argument - zero address"
      );
    });

    it("a new proxy is initialised and owned by its deployer", async () => {
      const proxy = await deployContract(
        deployer,
        "TrustedIssuersRegistryProxy",
        await platform.ia.getAddress()
      );
      const tir = await getContractAt("TrustedIssuersRegistry", await proxy.getAddress(), deployer);
      assert.equal(await tir.owner(), deployer.address);
      assert.deepEqual(await issuersOf(tir), []);
      await expectRevert(async () => tir.init(), "already initialized");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  addTrustedIssuer
  // ═══════════════════════════════════════════════════════════════════

  describe("addTrustedIssuer", () => {
    it("registers an issuer with its topics", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1, 2])).wait();

      assert.deepEqual(await issuersOf(tir), [lc(issuer)]);
      assert.deepEqual(await topicsOf(tir, issuer), [1n, 2n]);
      assert.equal(await tir.isTrustedIssuer(issuer), true);
      assert.deepEqual(await issuersFor(tir, 1), [lc(issuer)]);
      assert.deepEqual(await issuersFor(tir, 2), [lc(issuer)]);
    });

    it("emits TrustedIssuerAdded with the issuer and topics", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      const tx = await tir.addTrustedIssuer(issuer, [7, 8, 9]);
      const ev = await findEvent(tx, tir, "TrustedIssuerAdded");
      assert.ok(ev, "TrustedIssuerAdded not emitted");
      assert.equal(lc(ev.args[0]), lc(issuer));
      assert.deepEqual(ev.args[1].map(BigInt), [7n, 8n, 9n]);
    });

    it("keeps issuers in insertion order", async () => {
      const tir = await freshTir();
      const [a, b, c] = [randomAddress(), randomAddress(), randomAddress()];
      for (const i of [a, b, c]) await (await tir.addTrustedIssuer(i, [1])).wait();
      assert.deepEqual(await issuersOf(tir), [a, b, c].map(lc));
      assert.deepEqual(await issuersFor(tir, 1), [a, b, c].map(lc));
    });

    it("indexes each issuer only under its own topics", async () => {
      const tir = await freshTir();
      const [a, b] = [randomAddress(), randomAddress()];
      await (await tir.addTrustedIssuer(a, [1, 2])).wait();
      await (await tir.addTrustedIssuer(b, [2, 3])).wait();
      assert.deepEqual(await issuersFor(tir, 1), [lc(a)]);
      assert.deepEqual(await issuersFor(tir, 2), [lc(a), lc(b)]);
      assert.deepEqual(await issuersFor(tir, 3), [lc(b)]);
      assert.deepEqual(await issuersFor(tir, 4), []);
    });

    it("accepts topic 0 and the max uint256 topic", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      const big = 2n ** 256n - 1n;
      await (await tir.addTrustedIssuer(issuer, [0, big])).wait();
      assert.deepEqual(await topicsOf(tir, issuer), [0n, big]);
      assert.equal(await tir.hasClaimTopic(issuer, 0), true);
      assert.equal(await tir.hasClaimTopic(issuer, big), true);
    });

    it("does not require the issuer to be a contract (EOA accepted)", async () => {
      const tir = await freshTir();
      await (await tir.addTrustedIssuer(outsider.address, [1])).wait();
      assert.equal(await tir.isTrustedIssuer(outsider.address), true);
    });

    it("duplicate topics in the input are stored as-is (issuer indexed twice)", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1, 1])).wait();
      assert.deepEqual(await topicsOf(tir, issuer), [1n, 1n]);
      assert.deepEqual(await issuersFor(tir, 1), [lc(issuer), lc(issuer)]);
      // removal cleans both entries
      await (await tir.removeTrustedIssuer(issuer)).wait();
      assert.deepEqual(await issuersFor(tir, 1), []);
    });

    it("reverts on the zero address", async () => {
      const tir = await freshTir();
      await expectRevert(async () => tir.addTrustedIssuer(ZERO, [1]), "invalid argument - zero address");
    });

    it("reverts when the issuer already exists", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1])).wait();
      await expectRevert(async () => tir.addTrustedIssuer(issuer, [2]), "trusted Issuer already exists");
      assert.deepEqual(await topicsOf(tir, issuer), [1n]);
      assert.deepEqual(await issuersOf(tir), [lc(issuer)]);
    });

    it("reverts on an empty topic list", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await expectRevert(async () => tir.addTrustedIssuer(issuer, []), "trusted claim topics cannot be empty");
      assert.equal(await tir.isTrustedIssuer(issuer), false);
    });

    it("allows exactly 15 topics", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, range(1, 15))).wait();
      assert.equal((await topicsOf(tir, issuer)).length, 15);
    });

    it("reverts on 16 topics", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await expectRevert(
        async () => tir.addTrustedIssuer(issuer, range(1, 16)),
        "cannot have more than 15 claim topics"
      );
      assert.equal(await tir.isTrustedIssuer(issuer), false);
    });

    it("allows exactly 50 issuers and reverts on the 51st", async () => {
      const tir = await freshTir();
      for (let i = 0; i < 50; i++) await (await tir.addTrustedIssuer(randomAddress(), [1])).wait();
      assert.equal((await issuersOf(tir)).length, 50);
      assert.equal((await issuersFor(tir, 1)).length, 50);

      const extra = randomAddress();
      await expectRevert(
        async () => tir.addTrustedIssuer(extra, [1]),
        "cannot have more than 50 trusted issuers"
      );
      assert.equal(await tir.isTrustedIssuer(extra), false);
    });

    it("a slot freed by removeTrustedIssuer can be reused at the 50 limit", async () => {
      const tir = await freshTir();
      const issuers = [];
      for (let i = 0; i < 50; i++) {
        const a = randomAddress();
        issuers.push(a);
        await (await tir.addTrustedIssuer(a, [1])).wait();
      }
      await (await tir.removeTrustedIssuer(issuers[10])).wait();
      const extra = randomAddress();
      await (await tir.addTrustedIssuer(extra, [1])).wait();
      assert.equal((await issuersOf(tir)).length, 50);
      assert.equal(await tir.isTrustedIssuer(extra), true);
      assert.equal(await tir.isTrustedIssuer(issuers[10]), false);
    });

    it("reverts for a non-owner", async () => {
      const tir = await freshTir();
      await expectRevert(async () => tir.connect(outsider).addTrustedIssuer(randomAddress(), [1]), OWNER_ERR);
    });

    it("reverts for an IR agent (agents are not owners)", async () => {
      const tir = await getContractAt("TrustedIssuersRegistry", deal.tir, registrar);
      await expectRevert(async () => tir.addTrustedIssuer(randomAddress(), [1]), OWNER_ERR);
    });

    it("deal owner (platformAdmin) can add and remove on the deal's TIR proxy", async () => {
      const tir = await getContractAt("TrustedIssuersRegistry", deal.tir, platformAdmin);
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [777])).wait();
      try {
        assert.equal(await tir.isTrustedIssuer(issuer), true);
        assert.deepEqual(await issuersFor(tir, 777), [lc(issuer)]);
      } finally {
        await (await tir.removeTrustedIssuer(issuer)).wait(); // leave the shared deal empty
      }
      assert.deepEqual(await issuersOf(tir), []);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  removeTrustedIssuer
  // ═══════════════════════════════════════════════════════════════════

  describe("removeTrustedIssuer", () => {
    it("removes the only issuer and clears every index", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1, 2])).wait();
      await (await tir.removeTrustedIssuer(issuer)).wait();

      assert.deepEqual(await issuersOf(tir), []);
      assert.equal(await tir.isTrustedIssuer(issuer), false);
      assert.equal(await tir.hasClaimTopic(issuer, 1), false);
      assert.deepEqual(await issuersFor(tir, 1), []);
      assert.deepEqual(await issuersFor(tir, 2), []);
      await expectRevert(async () => tir.getTrustedIssuerClaimTopics(issuer), "trusted Issuer doesn't exist");
    });

    it("emits TrustedIssuerRemoved", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1])).wait();
      const tx = await tir.removeTrustedIssuer(issuer);
      const ev = await findEvent(tx, tir, "TrustedIssuerRemoved");
      assert.ok(ev, "TrustedIssuerRemoved not emitted");
      assert.equal(lc(ev.args[0]), lc(issuer));
    });

    it("removing a middle issuer swaps the last one into its place", async () => {
      const tir = await freshTir();
      const [a, b, c, d] = [randomAddress(), randomAddress(), randomAddress(), randomAddress()];
      for (const i of [a, b, c, d]) await (await tir.addTrustedIssuer(i, [1])).wait();
      await (await tir.removeTrustedIssuer(b)).wait();
      // swap-and-pop: [a,b,c,d] -> [a,d,c]
      assert.deepEqual(await issuersOf(tir), [a, d, c].map(lc));
      assert.deepEqual(await issuersFor(tir, 1), [a, d, c].map(lc));
    });

    it("removing the first issuer swaps the last one into index 0", async () => {
      const tir = await freshTir();
      const [a, b, c] = [randomAddress(), randomAddress(), randomAddress()];
      for (const i of [a, b, c]) await (await tir.addTrustedIssuer(i, [1])).wait();
      await (await tir.removeTrustedIssuer(a)).wait();
      assert.deepEqual(await issuersOf(tir), [c, b].map(lc));
    });

    it("removing the last issuer just pops it", async () => {
      const tir = await freshTir();
      const [a, b, c] = [randomAddress(), randomAddress(), randomAddress()];
      for (const i of [a, b, c]) await (await tir.addTrustedIssuer(i, [1])).wait();
      await (await tir.removeTrustedIssuer(c)).wait();
      assert.deepEqual(await issuersOf(tir), [a, b].map(lc));
    });

    it("leaves other issuers' topic indexes intact", async () => {
      const tir = await freshTir();
      const [a, b] = [randomAddress(), randomAddress()];
      await (await tir.addTrustedIssuer(a, [1, 2])).wait();
      await (await tir.addTrustedIssuer(b, [2, 3])).wait();
      await (await tir.removeTrustedIssuer(a)).wait();
      assert.deepEqual(await issuersFor(tir, 1), []);
      assert.deepEqual(await issuersFor(tir, 2), [lc(b)]);
      assert.deepEqual(await issuersFor(tir, 3), [lc(b)]);
      assert.deepEqual(await topicsOf(tir, b), [2n, 3n]);
    });

    it("a removed issuer can be added again with different topics", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1])).wait();
      await (await tir.removeTrustedIssuer(issuer)).wait();
      await (await tir.addTrustedIssuer(issuer, [5])).wait();
      assert.deepEqual(await topicsOf(tir, issuer), [5n]);
      assert.deepEqual(await issuersFor(tir, 1), []);
      assert.deepEqual(await issuersFor(tir, 5), [lc(issuer)]);
    });

    it("reverts on the zero address", async () => {
      const tir = await freshTir();
      await expectRevert(async () => tir.removeTrustedIssuer(ZERO), "invalid argument - zero address");
    });

    it("reverts for an unknown issuer", async () => {
      const tir = await freshTir();
      await expectRevert(async () => tir.removeTrustedIssuer(randomAddress()), "NOT a trusted issuer");
    });

    it("reverts when removing the same issuer twice", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1])).wait();
      await (await tir.removeTrustedIssuer(issuer)).wait();
      await expectRevert(async () => tir.removeTrustedIssuer(issuer), "NOT a trusted issuer");
    });

    it("reverts for a non-owner", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1])).wait();
      await expectRevert(async () => tir.connect(outsider).removeTrustedIssuer(issuer), OWNER_ERR);
      assert.equal(await tir.isTrustedIssuer(issuer), true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  updateIssuerClaimTopics
  // ═══════════════════════════════════════════════════════════════════

  describe("updateIssuerClaimTopics", () => {
    it("replaces the topic set and re-indexes", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1, 2])).wait();
      await (await tir.updateIssuerClaimTopics(issuer, [2, 3])).wait();

      assert.deepEqual(await topicsOf(tir, issuer), [2n, 3n]);
      assert.deepEqual(await issuersFor(tir, 1), []);
      assert.deepEqual(await issuersFor(tir, 2), [lc(issuer)]); // not duplicated
      assert.deepEqual(await issuersFor(tir, 3), [lc(issuer)]);
      assert.equal(await tir.hasClaimTopic(issuer, 1), false);
      assert.equal(await tir.hasClaimTopic(issuer, 3), true);
    });

    it("emits ClaimTopicsUpdated", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1])).wait();
      const tx = await tir.updateIssuerClaimTopics(issuer, [4, 5]);
      const ev = await findEvent(tx, tir, "ClaimTopicsUpdated");
      assert.ok(ev, "ClaimTopicsUpdated not emitted");
      assert.equal(lc(ev.args[0]), lc(issuer));
      assert.deepEqual(ev.args[1].map(BigInt), [4n, 5n]);
    });

    it("does not change the issuer list or its order", async () => {
      const tir = await freshTir();
      const [a, b, c] = [randomAddress(), randomAddress(), randomAddress()];
      for (const i of [a, b, c]) await (await tir.addTrustedIssuer(i, [1])).wait();
      await (await tir.updateIssuerClaimTopics(b, [9])).wait();
      assert.deepEqual(await issuersOf(tir), [a, b, c].map(lc));
    });

    it("moves the issuer to the end of a topic list it stays in (swap-and-pop + push)", async () => {
      const tir = await freshTir();
      const [a, b, c] = [randomAddress(), randomAddress(), randomAddress()];
      for (const i of [a, b, c]) await (await tir.addTrustedIssuer(i, [1])).wait();
      await (await tir.updateIssuerClaimTopics(a, [1])).wait();
      // [a,b,c] -> remove a -> [c,b] -> push a -> [c,b,a]
      assert.deepEqual(await issuersFor(tir, 1), [c, b, a].map(lc));
    });

    it("leaves other issuers' indexes intact", async () => {
      const tir = await freshTir();
      const [a, b] = [randomAddress(), randomAddress()];
      await (await tir.addTrustedIssuer(a, [1, 2])).wait();
      await (await tir.addTrustedIssuer(b, [1, 2])).wait();
      await (await tir.updateIssuerClaimTopics(a, [3])).wait();
      assert.deepEqual(await issuersFor(tir, 1), [lc(b)]);
      assert.deepEqual(await issuersFor(tir, 2), [lc(b)]);
      assert.deepEqual(await issuersFor(tir, 3), [lc(a)]);
      assert.deepEqual(await topicsOf(tir, b), [1n, 2n]);
    });

    it("allows exactly 15 topics", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1])).wait();
      await (await tir.updateIssuerClaimTopics(issuer, range(100, 114))).wait();
      assert.equal((await topicsOf(tir, issuer)).length, 15);
    });

    it("reverts on 16 topics", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1])).wait();
      await expectRevert(
        async () => tir.updateIssuerClaimTopics(issuer, range(1, 16)),
        "cannot have more than 15 claim topics"
      );
      assert.deepEqual(await topicsOf(tir, issuer), [1n]);
    });

    it("reverts on an empty topic list", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1])).wait();
      await expectRevert(async () => tir.updateIssuerClaimTopics(issuer, []), "claim topics cannot be empty");
      assert.deepEqual(await topicsOf(tir, issuer), [1n]);
    });

    it("reverts on the zero address", async () => {
      const tir = await freshTir();
      await expectRevert(async () => tir.updateIssuerClaimTopics(ZERO, [1]), "invalid argument - zero address");
    });

    it("reverts for an unknown issuer", async () => {
      const tir = await freshTir();
      await expectRevert(async () => tir.updateIssuerClaimTopics(randomAddress(), [1]), "NOT a trusted issuer");
    });

    it("reverts for a removed issuer", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1])).wait();
      await (await tir.removeTrustedIssuer(issuer)).wait();
      await expectRevert(async () => tir.updateIssuerClaimTopics(issuer, [2]), "NOT a trusted issuer");
    });

    it("reverts for a non-owner", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1])).wait();
      await expectRevert(async () => tir.connect(outsider).updateIssuerClaimTopics(issuer, [2]), OWNER_ERR);
      assert.deepEqual(await topicsOf(tir, issuer), [1n]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  views
  // ═══════════════════════════════════════════════════════════════════

  describe("views", () => {
    it("isTrustedIssuer is false for unknown and zero addresses", async () => {
      const tir = await freshTir();
      assert.equal(await tir.isTrustedIssuer(randomAddress()), false);
      assert.equal(await tir.isTrustedIssuer(ZERO), false);
    });

    it("getTrustedIssuerClaimTopics reverts for an unknown issuer", async () => {
      const tir = await freshTir();
      await expectRevert(
        async () => tir.getTrustedIssuerClaimTopics(randomAddress()),
        "trusted Issuer doesn't exist"
      );
    });

    it("hasClaimTopic is false for an unknown issuer and for a topic the issuer lacks", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      assert.equal(await tir.hasClaimTopic(issuer, 1), false);
      await (await tir.addTrustedIssuer(issuer, [1, 2])).wait();
      assert.equal(await tir.hasClaimTopic(issuer, 1), true);
      assert.equal(await tir.hasClaimTopic(issuer, 2), true);
      assert.equal(await tir.hasClaimTopic(issuer, 3), false);
    });

    it("getTrustedIssuersForClaimTopic is empty for an unused topic", async () => {
      const tir = await freshTir();
      assert.deepEqual(await issuersFor(tir, 12345), []);
    });

    it("all views are callable by anyone", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [3])).wait();
      const asOutsider = tir.connect(outsider);
      assert.deepEqual(await issuersOf(asOutsider), [lc(issuer)]);
      assert.deepEqual(await issuersFor(asOutsider, 3), [lc(issuer)]);
      assert.equal(await asOutsider.isTrustedIssuer(issuer), true);
      assert.equal(await asOutsider.hasClaimTopic(issuer, 3), true);
      assert.deepEqual(await topicsOf(asOutsider, issuer), [3n]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  ownership
  // ═══════════════════════════════════════════════════════════════════

  describe("ownership", () => {
    it("transferOwnership moves control to the new owner", async () => {
      const tir = await freshTir();
      await (await tir.transferOwnership(platformAdmin.address)).wait();
      assert.equal(await tir.owner(), platformAdmin.address);

      const issuer = randomAddress();
      await expectRevert(async () => tir.addTrustedIssuer(issuer, [1]), OWNER_ERR); // old owner locked out
      await (await tir.connect(platformAdmin).addTrustedIssuer(issuer, [1])).wait();
      assert.equal(await tir.isTrustedIssuer(issuer), true);
    });

    it("transferOwnership is owner only", async () => {
      const tir = await freshTir();
      await expectRevert(async () => tir.connect(outsider).transferOwnership(outsider.address), OWNER_ERR);
    });

    it("renounceOwnership locks the registry permanently", async () => {
      const tir = await freshTir();
      const issuer = randomAddress();
      await (await tir.addTrustedIssuer(issuer, [1])).wait();
      await (await tir.renounceOwnership()).wait();
      await expectRevert(async () => tir.addTrustedIssuer(randomAddress(), [1]), OWNER_ERR);
      await expectRevert(async () => tir.updateIssuerClaimTopics(issuer, [2]), OWNER_ERR);
      await expectRevert(async () => tir.removeTrustedIssuer(issuer), OWNER_ERR);
      assert.deepEqual(await topicsOf(tir, issuer), [1n]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  fuzz: random op sequences checked against a JS reference model
  // ═══════════════════════════════════════════════════════════════════

  describe("fuzz", () => {
    /**
     * Reference model mirroring the contract's storage, including swap-and-pop
     * ordering, so array order is checked exactly, not just as a set.
     */
    class Model {
      constructor() {
        this.issuers = []; // ordered
        this.topicsOf = new Map(); // issuer -> bigint[]
        this.byTopic = new Map(); // topic(bigint) -> issuer[]
      }
      static swapPop(arr, value) {
        const i = arr.indexOf(value);
        if (i === -1) return;
        arr[i] = arr[arr.length - 1];
        arr.pop();
      }
      list(topic) {
        if (!this.byTopic.has(topic)) this.byTopic.set(topic, []);
        return this.byTopic.get(topic);
      }
      unindex(issuer) {
        for (const t of this.topicsOf.get(issuer)) Model.swapPop(this.list(t), issuer);
      }
      index(issuer, topics) {
        this.topicsOf.set(issuer, topics);
        for (const t of topics) this.list(t).push(issuer);
      }
      add(issuer, topics) {
        this.issuers.push(issuer);
        this.index(issuer, topics);
      }
      remove(issuer) {
        Model.swapPop(this.issuers, issuer);
        this.unindex(issuer);
        this.topicsOf.delete(issuer);
      }
      update(issuer, topics) {
        this.unindex(issuer);
        this.index(issuer, topics);
      }
    }

    const TOPIC_POOL = 8; // small pool so issuers share topics heavily
    const pickTopics = (rand) => {
      const n = 1 + Math.floor(rand() * 4);
      const set = new Set();
      while (set.size < n) set.add(BigInt(Math.floor(rand() * TOPIC_POOL)));
      return [...set];
    };

    /** Light check: issuer list and per-topic indexes. Full check adds per-issuer views. */
    async function assertMatches(tir, model, ctx, full = false) {
      assert.deepEqual(await issuersOf(tir), model.issuers, `${ctx}: getTrustedIssuers`);
      for (let t = 0n; t < BigInt(TOPIC_POOL); t++) {
        assert.deepEqual(await issuersFor(tir, t), model.list(t), `${ctx}: topic ${t}`);
      }
      if (!full) return;
      for (const issuer of model.issuers) {
        const topics = model.topicsOf.get(issuer);
        assert.deepEqual(await topicsOf(tir, issuer), topics, `${ctx}: topics of ${issuer}`);
        assert.equal(await tir.isTrustedIssuer(issuer), true, `${ctx}: isTrusted ${issuer}`);
        for (let t = 0n; t < BigInt(TOPIC_POOL); t++) {
          assert.equal(await tir.hasClaimTopic(issuer, t), topics.includes(t), `${ctx}: has ${issuer}/${t}`);
        }
      }
    }

    for (const seed of [1, 42, 1337, 9001]) {
      it(`random add/update/remove sequence matches the model (seed ${seed})`, async () => {
        const rand = prng(seed);
        const tir = await freshTir();
        const model = new Model();
        const pool = Array.from({ length: 10 }, () => lc(randomAddress()));
        const removed = new Set();

        for (let step = 0; step < 40; step++) {
          const issuer = pool[Math.floor(rand() * pool.length)];
          const known = model.topicsOf.has(issuer);
          const r = rand();
          const ctx = `seed ${seed} step ${step}`;

          if (!known) {
            const topics = pickTopics(rand);
            await (await tir.addTrustedIssuer(issuer, topics)).wait();
            model.add(issuer, topics);
          } else if (r < 0.5) {
            const topics = pickTopics(rand);
            await (await tir.updateIssuerClaimTopics(issuer, topics)).wait();
            model.update(issuer, topics);
          } else if (r < 0.85) {
            await (await tir.removeTrustedIssuer(issuer)).wait();
            model.remove(issuer);
            removed.add(issuer);
          } else {
            // invalid op: re-adding an existing issuer must revert and change nothing
            await expectRevert(async () => tir.addTrustedIssuer(issuer, [0]), "trusted Issuer already exists");
          }
          await assertMatches(tir, model, ctx, step % 10 === 9);
        }
        await assertMatches(tir, model, `seed ${seed} final`, true);

        for (const issuer of removed) {
          if (model.topicsOf.has(issuer)) continue;
          assert.equal(await tir.isTrustedIssuer(issuer), false);
          await expectRevert(async () => tir.removeTrustedIssuer(issuer), "NOT a trusted issuer");
        }
      });
    }

    it("random topic-list lengths respect the 1..15 bound on add and update", async () => {
      const rand = prng(7);
      const tir = await freshTir();
      for (let i = 0; i < 12; i++) {
        const len = Math.floor(rand() * 20); // 0..19
        const issuer = randomAddress();
        const topics = range(1, len);
        if (len === 0) {
          await expectRevert(async () => tir.addTrustedIssuer(issuer, topics), "trusted claim topics cannot be empty");
        } else if (len > 15) {
          await expectRevert(async () => tir.addTrustedIssuer(issuer, topics), "cannot have more than 15 claim topics");
        } else {
          await (await tir.addTrustedIssuer(issuer, topics)).wait();
          const upLen = Math.floor(rand() * 20);
          const upTopics = range(100, 99 + upLen);
          if (upLen === 0) {
            await expectRevert(async () => tir.updateIssuerClaimTopics(issuer, upTopics), "claim topics cannot be empty");
          } else if (upLen > 15) {
            await expectRevert(
              async () => tir.updateIssuerClaimTopics(issuer, upTopics),
              "cannot have more than 15 claim topics"
            );
          } else {
            await (await tir.updateIssuerClaimTopics(issuer, upTopics)).wait();
            assert.deepEqual(await topicsOf(tir, issuer), upTopics.map(BigInt));
          }
        }
      }
    });
  });
});
