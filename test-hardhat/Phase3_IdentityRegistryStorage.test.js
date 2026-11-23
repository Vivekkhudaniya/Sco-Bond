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

describe("Phase 3: IdentityRegistryStorage", () => {
  let conn, provider;
  let deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, meridian, outsider;
  let deal;
  let ir, irs;
  let irsOwner;

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
    irs = await getContractAt("IdentityRegistryStorage", deal.irs, deployer);

    irsOwner = await irs.owner();

    await (await ir.registerIdentity(aurora.address, aurora.address, 356)).wait();
    await (await ir.registerIdentity(northbridge.address, northbridge.address, 276)).wait();
  });

  after(async () => {
    // conn lifecycle managed by Hardhat 3.22+
  });

  // ═══════════════════════════════════════════════════════════════════
  //  3.1 State after IR operations
  // ═══════════════════════════════════════════════════════════════════

  describe("3.1 State after IR operations", () => {
    it("storedIdentity returns correct identity after registration via IR", async () => {
      const stored = await irs.storedIdentity(aurora.address);
      assert.equal(stored.toLowerCase(), aurora.address.toLowerCase());
    });

    it("storedInvestorCountry returns correct country after registration via IR", async () => {
      assert.equal(await irs.storedInvestorCountry(aurora.address), 356n);
    });

    it("storedIdentity returns zero for unregistered address", async () => {
      const stored = await irs.storedIdentity(outsider.address);
      assert.equal(stored, ethers.ZeroAddress);
    });

    it("storedInvestorCountry returns zero for unregistered address", async () => {
      assert.equal(await irs.storedInvestorCountry(outsider.address), 0n);
    });

    it("identity update via IR is reflected in IRS", async () => {
      const newId = randomAddress();
      await (await ir.updateIdentity(aurora.address, newId)).wait();
      const stored = await irs.storedIdentity(aurora.address);
      assert.equal(stored.toLowerCase(), newId.toLowerCase());
      await (await ir.updateIdentity(aurora.address, aurora.address)).wait();
    });

    it("country update via IR is reflected in IRS", async () => {
      await (await ir.updateCountry(aurora.address, 840)).wait();
      assert.equal(await irs.storedInvestorCountry(aurora.address), 840n);
      await (await ir.updateCountry(aurora.address, 356)).wait();
    });

    it("delete via IR removes from IRS", async () => {
      const addr = randomAddress();
      await (await ir.registerIdentity(addr, addr, 100)).wait();
      assert.notEqual(await irs.storedIdentity(addr), ethers.ZeroAddress);
      await (await ir.deleteIdentity(addr)).wait();
      assert.equal(await irs.storedIdentity(addr), ethers.ZeroAddress);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  3.2 linkedIdentityRegistries
  // ═══════════════════════════════════════════════════════════════════

  describe("3.2 linkedIdentityRegistries", () => {
    it("IR is in the linked registries list", async () => {
      const linked = await irs.linkedIdentityRegistries();
      const found = linked.some(
        (addr) => addr.toLowerCase() === deal.ir.toLowerCase()
      );
      assert.equal(found, true, "IR not found in linked registries");
    });

    it("returns at least one linked registry", async () => {
      const linked = await irs.linkedIdentityRegistries();
      assert.ok(linked.length >= 1, "should have at least one linked IR");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  3.3 Access control — direct calls
  // ═══════════════════════════════════════════════════════════════════

  describe("3.3 Access control — direct IRS calls", () => {
    it("non-agent cannot call addIdentityToStorage", async () => {
      const irsAsOutsider = irs.connect(outsider);
      await assert.rejects(
        async () => {
          await irsAsOutsider.addIdentityToStorage(outsider.address, outsider.address, 100);
        },
        "non-agent should not add identity to storage"
      );
    });

    it("non-agent cannot call removeIdentityFromStorage", async () => {
      const irsAsOutsider = irs.connect(outsider);
      await assert.rejects(
        async () => {
          await irsAsOutsider.removeIdentityFromStorage(aurora.address);
        },
        "non-agent should not remove from storage"
      );
    });

    it("non-agent cannot call modifyStoredIdentity", async () => {
      const irsAsOutsider = irs.connect(outsider);
      await assert.rejects(
        async () => {
          await irsAsOutsider.modifyStoredIdentity(aurora.address, randomAddress());
        },
        "non-agent should not modify identity"
      );
    });

    it("non-agent cannot call modifyStoredInvestorCountry", async () => {
      const irsAsOutsider = irs.connect(outsider);
      await assert.rejects(
        async () => {
          await irsAsOutsider.modifyStoredInvestorCountry(aurora.address, 999);
        },
        "non-agent should not modify country"
      );
    });

    it("deployer (non-agent) cannot call write functions", async () => {
      const irsAsDeployer = irs.connect(deployer);
      await assert.rejects(
        async () => {
          await irsAsDeployer.addIdentityToStorage(outsider.address, outsider.address, 100);
        },
        "deployer should not write to IRS directly"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  3.4 bindIdentityRegistry / unbindIdentityRegistry
  // ═══════════════════════════════════════════════════════════════════

  describe("3.4 bind / unbind IdentityRegistry", () => {
    it("IRS has an owner", async () => {
      assert.notEqual(irsOwner, ethers.ZeroAddress, "IRS should have an owner");
    });

    it("non-owner cannot bind a new IR", async () => {
      const irsAsOutsider = irs.connect(outsider);
      await assert.rejects(
        async () => {
          await irsAsOutsider.bindIdentityRegistry(randomAddress());
        },
        "non-owner should not bind IR"
      );
    });

    it("owner can bind a new IR and it appears in linked list", async () => {
      const ownerSigner = await findLocalSigner(provider, irsOwner);
      if (!ownerSigner) return; // skip if owner is not a local signer
      const irsAsOwner = irs.connect(ownerSigner);
      const dummyIR = randomAddress();

      const linkedBefore = await irs.linkedIdentityRegistries();
      const countBefore = linkedBefore.length;

      await (await irsAsOwner.bindIdentityRegistry(dummyIR)).wait();
      const linkedAfter = await irs.linkedIdentityRegistries();
      assert.equal(linkedAfter.length, countBefore + 1);
      const found = linkedAfter.some(a => a.toLowerCase() === dummyIR.toLowerCase());
      assert.equal(found, true, "new IR should be in linked list");

      await (await irsAsOwner.unbindIdentityRegistry(dummyIR)).wait();
    });

    it("emits IdentityRegistryBound event on bind", async () => {
      const ownerSigner = await findLocalSigner(provider, irsOwner);
      if (!ownerSigner) return;
      const irsAsOwner = irs.connect(ownerSigner);
      const dummyIR = randomAddress();
      const receipt = await (await irsAsOwner.bindIdentityRegistry(dummyIR)).wait();
      const event = findEvent(receipt, irs, "IdentityRegistryBound");
      assert.ok(event, "IdentityRegistryBound event not found");
      await (await irsAsOwner.unbindIdentityRegistry(dummyIR)).wait();
    });

    it("unbinding removes from linked list and emits event", async () => {
      const ownerSigner = await findLocalSigner(provider, irsOwner);
      if (!ownerSigner) return;
      const irsAsOwner = irs.connect(ownerSigner);
      const dummyIR = randomAddress();

      await (await irsAsOwner.bindIdentityRegistry(dummyIR)).wait();
      const receipt = await (await irsAsOwner.unbindIdentityRegistry(dummyIR)).wait();
      const event = findEvent(receipt, irs, "IdentityRegistryUnbound");
      assert.ok(event, "IdentityRegistryUnbound event not found");

      const linked = await irs.linkedIdentityRegistries();
      const found = linked.some(a => a.toLowerCase() === dummyIR.toLowerCase());
      assert.equal(found, false, "unbound IR should not be in linked list");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  3.5 Fuzz: IR → IRS state consistency
  // ═══════════════════════════════════════════════════════════════════

  describe("3.5 Fuzz: IR → IRS state consistency", () => {
    it("register via IR and verify IRS state for 20 random addresses", async () => {
      for (let i = 0; i < 20; i++) {
        const addr = randomAddress();
        const country = randomCountry();
        await (await ir.registerIdentity(addr, addr, country)).wait();

        const storedId = await irs.storedIdentity(addr);
        assert.equal(storedId.toLowerCase(), addr.toLowerCase(), `identity mismatch at ${i}`);
        assert.equal(await irs.storedInvestorCountry(addr), BigInt(country), `country mismatch at ${i}`);
      }
    });

    it("register-delete cycle: IRS returns zero after IR delete for 10 addresses", async () => {
      for (let i = 0; i < 10; i++) {
        const addr = randomAddress();
        await (await ir.registerIdentity(addr, addr, randomCountry())).wait();
        assert.notEqual(await irs.storedIdentity(addr), ethers.ZeroAddress);
        await (await ir.deleteIdentity(addr)).wait();
        assert.equal(await irs.storedIdentity(addr), ethers.ZeroAddress);
        assert.equal(await irs.storedInvestorCountry(addr), 0n);
      }
    });

    it("country update fuzz: 10 random updates propagate to IRS", async () => {
      const addr = randomAddress();
      await (await ir.registerIdentity(addr, addr, 100)).wait();
      for (let i = 0; i < 10; i++) {
        const country = randomCountry();
        await (await ir.updateCountry(addr, country)).wait();
        assert.equal(await irs.storedInvestorCountry(addr), BigInt(country));
      }
    });

    it("identity update fuzz: 10 random swaps propagate to IRS", async () => {
      const addr = randomAddress();
      await (await ir.registerIdentity(addr, addr, 356)).wait();
      for (let i = 0; i < 10; i++) {
        const newId = randomAddress();
        await (await ir.updateIdentity(addr, newId)).wait();
        const stored = await irs.storedIdentity(addr);
        assert.equal(stored.toLowerCase(), newId.toLowerCase());
      }
    });
  });
});

async function findLocalSigner(provider, address) {
  const accounts = await provider.listAccounts();
  for (const acc of accounts) {
    if (acc.address.toLowerCase() === address.toLowerCase()) return acc;
  }
  return null;
}
