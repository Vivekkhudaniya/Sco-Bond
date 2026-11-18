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
  findEvent,
  randomAddress,
  randomCountry,
} from "./helpers.js";

describe("Phase 2: IdentityRegistry", () => {
  let conn, provider;
  let deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, meridian, outsider;
  let deal;
  let ir;

  before(async () => {
    ({ conn, provider } = await setupProvider());
    const signers = await getSigners(provider);
    deployer = signers.deployer;
    platformAdmin = signers.platformAdmin;
    registrar = signers.registrar;
    bndSafe = signers.bndSafe;
    aurora = signers.aurora;
    northbridge = signers.northbridge;
    meridian = signers.meridian;
    outsider = signers.outsider;

    const platform = await deployPlatform(deployer);
    deal = await deployDeal(
      platform.gateway, deployer, platformAdmin, registrar, bndSafe, platform.supplyLimitModule
    );

    ir = await getContractAt("IdentityRegistry", deal.ir, registrar);
  });

  after(async () => {
    if (conn) await conn.close();
  });

  // ═══════════════════════════════════════════════════════════════════
  //  2.1 registerIdentity
  // ═══════════════════════════════════════════════════════════════════

  describe("2.1 registerIdentity", () => {
    it("registrar can register an investor", async () => {
      await (await ir.registerIdentity(aurora.address, aurora.address, 356)).wait();
      assert.equal(await ir.contains(aurora.address), true);
    });

    it("emits IdentityRegistered event", async () => {
      const tx = await ir.registerIdentity(northbridge.address, northbridge.address, 276);
      const receipt = await tx.wait();
      const event = findEvent(receipt, ir, "IdentityRegistered");
      assert.ok(event, "IdentityRegistered event not found");
      assert.equal(event.args[0].toLowerCase(), northbridge.address.toLowerCase());
    });

    it("non-agent cannot register", async () => {
      const irAsOutsider = ir.connect(outsider);
      await assert.rejects(
        async () => {
          await irAsOutsider.registerIdentity(outsider.address, outsider.address, 100);
        },
        "non-agent should not register"
      );
    });

    it("cannot register same address twice", async () => {
      await assert.rejects(
        async () => {
          await ir.registerIdentity(aurora.address, aurora.address, 356);
        },
        "duplicate registration should revert"
      );
    });

    it("cannot register with zero identity", async () => {
      const addr = randomAddress();
      await assert.rejects(
        async () => {
          await ir.registerIdentity(addr, ethers.ZeroAddress, 356);
        },
        "zero identity should revert"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  2.2 batchRegisterIdentity
  // ═══════════════════════════════════════════════════════════════════

  describe("2.2 batchRegisterIdentity", () => {
    it("registers multiple investors in one call", async () => {
      await (await ir.batchRegisterIdentity(
        [meridian.address, bndSafe.address],
        [meridian.address, bndSafe.address],
        [826, 840]
      )).wait();

      assert.equal(await ir.contains(meridian.address), true);
      assert.equal(await ir.contains(bndSafe.address), true);
      assert.equal(await ir.investorCountry(meridian.address), 826n);
      assert.equal(await ir.investorCountry(bndSafe.address), 840n);
    });

    it("non-agent cannot batch register", async () => {
      const irAsOutsider = ir.connect(outsider);
      const addr = randomAddress();
      await assert.rejects(
        async () => {
          await irAsOutsider.batchRegisterIdentity([addr], [addr], [100]);
        },
        "non-agent should not batch register"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  2.3 View functions
  // ═══════════════════════════════════════════════════════════════════

  describe("2.3 View functions", () => {
    it("contains returns true for registered investor", async () => {
      assert.equal(await ir.contains(aurora.address), true);
    });

    it("contains returns false for unregistered address", async () => {
      assert.equal(await ir.contains(outsider.address), false);
    });

    it("isVerified returns true (empty claim topics = pure whitelist)", async () => {
      assert.equal(await ir.isVerified(aurora.address), true);
    });

    it("isVerified returns false for unregistered address", async () => {
      assert.equal(await ir.isVerified(outsider.address), false);
    });

    it("identity returns stored identity address", async () => {
      const id = await ir.identity(aurora.address);
      assert.equal(id.toLowerCase(), aurora.address.toLowerCase());
    });

    it("investorCountry returns stored country code", async () => {
      assert.equal(await ir.investorCountry(aurora.address), 356n);
    });

    it("identityStorage returns linked IRS address", async () => {
      const irs = await ir.identityStorage();
      assert.equal(irs.toLowerCase(), deal.irs.toLowerCase());
    });

    it("topicsRegistry returns linked CTR address", async () => {
      const ctr = await ir.topicsRegistry();
      assert.equal(ctr.toLowerCase(), deal.ctr.toLowerCase());
    });

    it("issuersRegistry returns linked TIR address", async () => {
      const tir = await ir.issuersRegistry();
      assert.equal(tir.toLowerCase(), deal.tir.toLowerCase());
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  2.4 updateIdentity
  // ═══════════════════════════════════════════════════════════════════

  describe("2.4 updateIdentity", () => {
    it("registrar can update identity", async () => {
      const newId = randomAddress();
      await (await ir.updateIdentity(aurora.address, newId)).wait();
      const stored = await ir.identity(aurora.address);
      assert.equal(stored.toLowerCase(), newId.toLowerCase());
    });

    it("emits IdentityUpdated event", async () => {
      const newId = randomAddress();
      const receipt = await (await ir.updateIdentity(northbridge.address, newId)).wait();
      const event = findEvent(receipt, ir, "IdentityUpdated");
      assert.ok(event, "IdentityUpdated event not found");
    });

    it("non-agent cannot update identity", async () => {
      await assert.rejects(
        async () => {
          await ir.connect(outsider).updateIdentity(aurora.address, randomAddress());
        },
        "non-agent should not update identity"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  2.5 updateCountry
  // ═══════════════════════════════════════════════════════════════════

  describe("2.5 updateCountry", () => {
    it("registrar can update country", async () => {
      await (await ir.updateCountry(aurora.address, 840)).wait();
      assert.equal(await ir.investorCountry(aurora.address), 840n);
    });

    it("emits CountryUpdated event", async () => {
      const receipt = await (await ir.updateCountry(northbridge.address, 392)).wait();
      const event = findEvent(receipt, ir, "CountryUpdated");
      assert.ok(event, "CountryUpdated event not found");
    });

    it("non-agent cannot update country", async () => {
      await assert.rejects(
        async () => {
          await ir.connect(outsider).updateCountry(aurora.address, 826);
        },
        "non-agent should not update country"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  2.6 deleteIdentity
  // ═══════════════════════════════════════════════════════════════════

  describe("2.6 deleteIdentity", () => {
    it("non-agent cannot delete", async () => {
      await assert.rejects(
        async () => {
          await ir.connect(outsider).deleteIdentity(meridian.address);
        },
        "non-agent should not delete"
      );
    });

    it("registrar can delete identity and emits event", async () => {
      const receipt = await (await ir.deleteIdentity(meridian.address)).wait();
      const event = findEvent(receipt, ir, "IdentityRemoved");
      assert.ok(event, "IdentityRemoved event not found");
      assert.equal(await ir.contains(meridian.address), false);
      assert.equal(await ir.isVerified(meridian.address), false);
    });

    it("cannot delete unregistered address", async () => {
      await assert.rejects(
        async () => {
          await ir.deleteIdentity(outsider.address);
        },
        "deleting unregistered should revert"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  2.7 Owner functions (setRegistries)
  // ═══════════════════════════════════════════════════════════════════

  describe("2.7 Owner functions", () => {
    it("owner can set identity registry storage", async () => {
      const irAsOwner = ir.connect(platformAdmin);
      const dummy = randomAddress();
      const receipt = await (await irAsOwner.setIdentityRegistryStorage(dummy)).wait();
      assert.ok(findEvent(receipt, ir, "IdentityStorageSet"));
      await (await irAsOwner.setIdentityRegistryStorage(deal.irs)).wait();
    });

    it("non-owner cannot set identity registry storage", async () => {
      await assert.rejects(
        async () => {
          await ir.connect(outsider).setIdentityRegistryStorage(randomAddress());
        },
        "non-owner should not set IRS"
      );
    });

    it("owner can set claim topics registry", async () => {
      const irAsOwner = ir.connect(platformAdmin);
      const dummy = randomAddress();
      const receipt = await (await irAsOwner.setClaimTopicsRegistry(dummy)).wait();
      assert.ok(findEvent(receipt, ir, "ClaimTopicsRegistrySet"));
      await (await irAsOwner.setClaimTopicsRegistry(deal.ctr)).wait();
    });

    it("owner can set trusted issuers registry", async () => {
      const irAsOwner = ir.connect(platformAdmin);
      const dummy = randomAddress();
      const receipt = await (await irAsOwner.setTrustedIssuersRegistry(dummy)).wait();
      assert.ok(findEvent(receipt, ir, "TrustedIssuersRegistrySet"));
      await (await irAsOwner.setTrustedIssuersRegistry(deal.tir)).wait();
    });

    it("non-owner cannot set claim topics registry", async () => {
      await assert.rejects(
        async () => {
          await ir.connect(outsider).setClaimTopicsRegistry(randomAddress());
        },
        "non-owner should not set CTR"
      );
    });

    it("non-owner cannot set trusted issuers registry", async () => {
      await assert.rejects(
        async () => {
          await ir.connect(outsider).setTrustedIssuersRegistry(randomAddress());
        },
        "non-owner should not set TIR"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  2.8 Agent management
  // ═══════════════════════════════════════════════════════════════════

  describe("2.8 Agent management", () => {
    it("registrar is an IR agent", async () => {
      const agentRole = await getContractAt("AgentRole", deal.ir, deployer);
      assert.equal(await agentRole.isAgent(registrar.address), true);
    });

    it("token address is an IR agent", async () => {
      const agentRole = await getContractAt("AgentRole", deal.ir, deployer);
      assert.equal(await agentRole.isAgent(deal.token), true);
    });

    it("owner can add a new agent", async () => {
      const agentRole = await getContractAt("AgentRole", deal.ir, platformAdmin);
      await (await agentRole.addAgent(outsider.address)).wait();
      assert.equal(await agentRole.isAgent(outsider.address), true);
    });

    it("owner can remove an agent", async () => {
      const agentRole = await getContractAt("AgentRole", deal.ir, platformAdmin);
      await (await agentRole.removeAgent(outsider.address)).wait();
      assert.equal(await agentRole.isAgent(outsider.address), false);
    });

    it("non-owner cannot add agent", async () => {
      const agentRole = await getContractAt("AgentRole", deal.ir, outsider);
      await assert.rejects(
        async () => {
          await agentRole.addAgent(outsider.address);
        },
        "non-owner should not add agent"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  2.9 Fuzz tests
  // ═══════════════════════════════════════════════════════════════════

  describe("2.9 Fuzz: random registrations", () => {
    it("registers and verifies 20 random addresses with random countries", async () => {
      for (let i = 0; i < 20; i++) {
        const addr = randomAddress();
        const country = randomCountry();
        await (await ir.registerIdentity(addr, addr, country)).wait();

        assert.equal(await ir.contains(addr), true, `contains failed at ${i}`);
        assert.equal(await ir.isVerified(addr), true, `isVerified failed at ${i}`);
        assert.equal(await ir.investorCountry(addr), BigInt(country), `country mismatch at ${i}`);
      }
    });

    it("register-delete cycle preserves invariant for 10 addresses", async () => {
      for (let i = 0; i < 10; i++) {
        const addr = randomAddress();
        await (await ir.registerIdentity(addr, addr, randomCountry())).wait();
        assert.equal(await ir.contains(addr), true);
        assert.equal(await ir.isVerified(addr), true);
        await (await ir.deleteIdentity(addr)).wait();
        assert.equal(await ir.contains(addr), false);
        assert.equal(await ir.isVerified(addr), false);
      }
    });

    it("boundary country codes are accepted (0, 1, 999, 65535)", async () => {
      const codes = [0, 1, 500, 999, 65535];
      for (const code of codes) {
        const addr = randomAddress();
        await (await ir.registerIdentity(addr, addr, code)).wait();
        assert.equal(await ir.investorCountry(addr), BigInt(code));
      }
    });

    it("update country fuzz — 10 random updates on same address", async () => {
      const addr = randomAddress();
      await (await ir.registerIdentity(addr, addr, 100)).wait();
      for (let i = 0; i < 10; i++) {
        const country = randomCountry();
        await (await ir.updateCountry(addr, country)).wait();
        assert.equal(await ir.investorCountry(addr), BigInt(country));
      }
    });

    it("update identity fuzz — 10 random identity swaps", async () => {
      const addr = randomAddress();
      await (await ir.registerIdentity(addr, addr, 356)).wait();
      for (let i = 0; i < 10; i++) {
        const newId = randomAddress();
        await (await ir.updateIdentity(addr, newId)).wait();
        const stored = await ir.identity(addr);
        assert.equal(stored.toLowerCase(), newId.toLowerCase());
        assert.equal(await ir.isVerified(addr), true);
      }
    });
  });
});
