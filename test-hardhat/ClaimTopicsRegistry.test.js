import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  setupProvider,
  getSigners,
  deployPlatform,
  deployDeal,
  deployContract,
  getContractAt,
} from "./helpers.js";

const OWNER_ERR = "Ownable: caller is not the owner";

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

describe("ClaimTopicsRegistry", () => {
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
  async function freshCtr() {
    const ctr = await deployContract(deployer, "ClaimTopicsRegistry");
    await (await ctr.init()).wait();
    return ctr;
  }

  const topicsOf = async (ctr) => (await ctr.getClaimTopics()).map((t) => BigInt(t));

  // ═══════════════════════════════════════════════════════════════════
  //  init / deal wiring
  // ═══════════════════════════════════════════════════════════════════

  describe("init and deal wiring", () => {
    it("deal CTR proxy is owned by platformAdmin", async () => {
      const ctr = await getContractAt("ClaimTopicsRegistry", deal.ctr, deployer);
      assert.equal(await ctr.owner(), platformAdmin.address);
    });

    it("deal CTR starts with no required topics", async () => {
      const ctr = await getContractAt("ClaimTopicsRegistry", deal.ctr, deployer);
      assert.deepEqual(await topicsOf(ctr), []);
    });

    it("deal CTR is the one wired into the deal's IdentityRegistry", async () => {
      const ir = await getContractAt("IdentityRegistry", deal.ir, deployer);
      assert.equal(await ir.topicsRegistry(), deal.ctr);
    });

    it("init sets the caller as owner", async () => {
      const ctr = await freshCtr();
      assert.equal(await ctr.owner(), deployer.address);
    });

    it("cannot be initialised twice", async () => {
      const ctr = await freshCtr();
      await expectRevert(async () => ctr.init(), "already initialized");
    });

    it("deal CTR proxy cannot be re-initialised", async () => {
      const ctr = await getContractAt("ClaimTopicsRegistry", deal.ctr, deployer);
      await expectRevert(async () => ctr.init(), "already initialized");
    });

    it("an uninitialised registry has no owner, so addClaimTopic reverts", async () => {
      const ctr = await deployContract(deployer, "ClaimTopicsRegistry"); // init() never called
      assert.equal(await ctr.owner(), "0x0000000000000000000000000000000000000000");
      await expectRevert(async () => ctr.addClaimTopic(1), OWNER_ERR);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  addClaimTopic
  // ═══════════════════════════════════════════════════════════════════

  describe("addClaimTopic", () => {
    it("adds a topic and returns it from getClaimTopics", async () => {
      const ctr = await freshCtr();
      await (await ctr.addClaimTopic(1)).wait();
      assert.deepEqual(await topicsOf(ctr), [1n]);
    });

    it("emits ClaimTopicAdded", async () => {
      const ctr = await freshCtr();
      const tx = await ctr.addClaimTopic(42);
      const ev = await findEvent(tx, ctr, "ClaimTopicAdded");
      assert.ok(ev, "ClaimTopicAdded not emitted");
      assert.equal(ev.args[0], 42n);
    });

    it("keeps topics in insertion order", async () => {
      const ctr = await freshCtr();
      for (const t of [5, 3, 9]) await (await ctr.addClaimTopic(t)).wait();
      assert.deepEqual(await topicsOf(ctr), [5n, 3n, 9n]);
    });

    it("accepts topic 0 and very large topic ids", async () => {
      const ctr = await freshCtr();
      const big = 2n ** 256n - 1n;
      await (await ctr.addClaimTopic(0)).wait();
      await (await ctr.addClaimTopic(big)).wait();
      assert.deepEqual(await topicsOf(ctr), [0n, big]);
    });

    it("reverts on a duplicate topic", async () => {
      const ctr = await freshCtr();
      await (await ctr.addClaimTopic(1)).wait();
      await expectRevert(async () => ctr.addClaimTopic(1), "claimTopic already exists");
      assert.deepEqual(await topicsOf(ctr), [1n]);
    });

    it("allows exactly 15 topics", async () => {
      const ctr = await freshCtr();
      for (let t = 1; t <= 15; t++) await (await ctr.addClaimTopic(t)).wait();
      assert.equal((await topicsOf(ctr)).length, 15);
    });

    it("reverts when adding a 16th topic", async () => {
      const ctr = await freshCtr();
      for (let t = 1; t <= 15; t++) await (await ctr.addClaimTopic(t)).wait();
      await expectRevert(async () => ctr.addClaimTopic(16), "cannot require more than 15 topics");
      assert.equal((await topicsOf(ctr)).length, 15);
    });

    it("a slot freed by removeClaimTopic can be reused at the 15 limit", async () => {
      const ctr = await freshCtr();
      for (let t = 1; t <= 15; t++) await (await ctr.addClaimTopic(t)).wait();
      await (await ctr.removeClaimTopic(7)).wait();
      await (await ctr.addClaimTopic(100)).wait();
      assert.equal((await topicsOf(ctr)).length, 15);
      assert.ok((await topicsOf(ctr)).includes(100n));
      assert.ok(!(await topicsOf(ctr)).includes(7n));
    });

    it("reverts for a non-owner", async () => {
      const ctr = await freshCtr();
      await expectRevert(async () => ctr.connect(outsider).addClaimTopic(1), OWNER_ERR);
    });

    it("reverts for an IR agent (agents are not owners)", async () => {
      const ctr = await getContractAt("ClaimTopicsRegistry", deal.ctr, registrar);
      await expectRevert(async () => ctr.addClaimTopic(1), OWNER_ERR);
    });

    it("deal owner (platformAdmin) can add and remove on the deal's CTR proxy", async () => {
      const ctr = await getContractAt("ClaimTopicsRegistry", deal.ctr, platformAdmin);
      await (await ctr.addClaimTopic(777)).wait();
      try {
        assert.ok((await topicsOf(ctr)).includes(777n));
      } finally {
        await (await ctr.removeClaimTopic(777)).wait(); // leave the shared deal empty
      }
      assert.deepEqual(await topicsOf(ctr), []);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  removeClaimTopic
  // ═══════════════════════════════════════════════════════════════════

  describe("removeClaimTopic", () => {
    it("removes the only topic", async () => {
      const ctr = await freshCtr();
      await (await ctr.addClaimTopic(1)).wait();
      await (await ctr.removeClaimTopic(1)).wait();
      assert.deepEqual(await topicsOf(ctr), []);
    });

    it("emits ClaimTopicRemoved", async () => {
      const ctr = await freshCtr();
      await (await ctr.addClaimTopic(8)).wait();
      const tx = await ctr.removeClaimTopic(8);
      const ev = await findEvent(tx, ctr, "ClaimTopicRemoved");
      assert.ok(ev, "ClaimTopicRemoved not emitted");
      assert.equal(ev.args[0], 8n);
    });

    it("removing a middle topic swaps the last one into its place", async () => {
      const ctr = await freshCtr();
      for (const t of [1, 2, 3, 4]) await (await ctr.addClaimTopic(t)).wait();
      await (await ctr.removeClaimTopic(2)).wait();
      // swap-and-pop: [1,2,3,4] -> [1,4,3]
      assert.deepEqual(await topicsOf(ctr), [1n, 4n, 3n]);
    });

    it("removing the last topic just pops it", async () => {
      const ctr = await freshCtr();
      for (const t of [1, 2, 3]) await (await ctr.addClaimTopic(t)).wait();
      await (await ctr.removeClaimTopic(3)).wait();
      assert.deepEqual(await topicsOf(ctr), [1n, 2n]);
    });

    it("removing the first topic swaps the last one into index 0", async () => {
      const ctr = await freshCtr();
      for (const t of [1, 2, 3]) await (await ctr.addClaimTopic(t)).wait();
      await (await ctr.removeClaimTopic(1)).wait();
      assert.deepEqual(await topicsOf(ctr), [3n, 2n]);
    });

    it("removing a topic that is not present is a silent no-op (no revert, no event)", async () => {
      const ctr = await freshCtr();
      await (await ctr.addClaimTopic(1)).wait();
      const tx = await ctr.removeClaimTopic(999);
      const ev = await findEvent(tx, ctr, "ClaimTopicRemoved");
      assert.equal(ev, undefined, "should not emit for a topic that was never there");
      assert.deepEqual(await topicsOf(ctr), [1n]);
    });

    it("removing from an empty registry is a no-op", async () => {
      const ctr = await freshCtr();
      await (await ctr.removeClaimTopic(1)).wait();
      assert.deepEqual(await topicsOf(ctr), []);
    });

    it("a removed topic can be added again", async () => {
      const ctr = await freshCtr();
      await (await ctr.addClaimTopic(1)).wait();
      await (await ctr.removeClaimTopic(1)).wait();
      await (await ctr.addClaimTopic(1)).wait();
      assert.deepEqual(await topicsOf(ctr), [1n]);
    });

    it("removing the same topic twice only affects it once", async () => {
      const ctr = await freshCtr();
      for (const t of [1, 2]) await (await ctr.addClaimTopic(t)).wait();
      await (await ctr.removeClaimTopic(1)).wait();
      await (await ctr.removeClaimTopic(1)).wait();
      assert.deepEqual(await topicsOf(ctr), [2n]);
    });

    it("reverts for a non-owner, even for a topic that is not present", async () => {
      const ctr = await freshCtr();
      await (await ctr.addClaimTopic(1)).wait();
      await expectRevert(async () => ctr.connect(outsider).removeClaimTopic(1), OWNER_ERR);
      await expectRevert(async () => ctr.connect(outsider).removeClaimTopic(999), OWNER_ERR);
      assert.deepEqual(await topicsOf(ctr), [1n]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  ownership
  // ═══════════════════════════════════════════════════════════════════

  describe("ownership", () => {
    it("transferOwnership moves control to the new owner", async () => {
      const ctr = await freshCtr();
      await (await ctr.transferOwnership(platformAdmin.address)).wait();
      assert.equal(await ctr.owner(), platformAdmin.address);

      await expectRevert(async () => ctr.addClaimTopic(1), OWNER_ERR); // old owner locked out
      await (await ctr.connect(platformAdmin).addClaimTopic(1)).wait();
      assert.deepEqual(await topicsOf(ctr), [1n]);
    });

    it("transferOwnership is owner only", async () => {
      const ctr = await freshCtr();
      await expectRevert(async () => ctr.connect(outsider).transferOwnership(outsider.address), OWNER_ERR);
    });

    it("renounceOwnership locks the registry permanently", async () => {
      const ctr = await freshCtr();
      await (await ctr.addClaimTopic(1)).wait();
      await (await ctr.renounceOwnership()).wait();
      await expectRevert(async () => ctr.addClaimTopic(2), OWNER_ERR);
      await expectRevert(async () => ctr.removeClaimTopic(1), OWNER_ERR);
      assert.deepEqual(await topicsOf(ctr), [1n]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getClaimTopics
  // ═══════════════════════════════════════════════════════════════════

  describe("getClaimTopics", () => {
    it("is callable by anyone", async () => {
      const ctr = await freshCtr();
      await (await ctr.addClaimTopic(3)).wait();
      const asOutsider = ctr.connect(outsider);
      assert.deepEqual((await asOutsider.getClaimTopics()).map(BigInt), [3n]);
    });
  });
});
