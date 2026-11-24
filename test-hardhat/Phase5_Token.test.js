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
  SUPPLY_LIMIT,
} from "./helpers.js";

describe("Phase 5: Token", () => {
  let conn, provider;
  let deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, outsider;
  let platform, deal;
  let token, ir;

  before(async () => {
    ({ conn, provider } = await setupProvider());
    const signers = await getSigners(provider);
    deployer = signers.deployer;
    platformAdmin = signers.platformAdmin;
    registrar = signers.registrar;
    bndSafe = signers.bndSafe;
    aurora = signers.aurora;
    northbridge = signers.northbridge;
    outsider = signers.outsider;

    platform = await deployPlatform(deployer);
    deal = await deployDeal(
      platform.gateway, deployer, platformAdmin, registrar, bndSafe, platform.supplyLimitModule
    );

    token = await getContractAt("Token", deal.token, bndSafe);
    ir = await getContractAt("IdentityRegistry", deal.ir, registrar);

    // Whitelist bndSafe, aurora, northbridge
    await (await ir.registerIdentity(bndSafe.address, bndSafe.address, 356)).wait();
    await (await ir.registerIdentity(aurora.address, aurora.address, 356)).wait();
    await (await ir.registerIdentity(northbridge.address, northbridge.address, 276)).wait();

    // Unpause token (bndSafe is token agent)
    await (await token.unpause()).wait();

    // Mint 3000 bonds to bndSafe
    await (await token.mint(bndSafe.address, 3000n)).wait();
  });

  after(async () => {
    // conn lifecycle managed by Hardhat 3.22+
  });

  // ═══════════════════════════════════════════════════════════════════
  //  5.1 Metadata
  // ═══════════════════════════════════════════════════════════════════

  describe("5.1 Metadata", () => {
    it("name returns correct token name", async () => {
      assert.equal(await token.name(), "ACME Corp / 3.875% Fixed EMTN");
    });

    it("symbol returns correct token symbol", async () => {
      assert.equal(await token.symbol(), "TR-51X5RT-01");
    });

    it("decimals returns 0", async () => {
      assert.equal(await token.decimals(), 0n);
    });

    it("version returns a non-empty string", async () => {
      const v = await token.version();
      assert.ok(v.length > 0, "version should be non-empty");
    });

    it("onchainID returns zero address", async () => {
      assert.equal(await token.onchainID(), ethers.ZeroAddress);
    });

    it("totalSupply returns 3000 after initial mint", async () => {
      assert.equal(await token.totalSupply(), 3000n);
    });

    it("identityRegistry returns the deal IR address", async () => {
      const irAddr = await token.identityRegistry();
      assert.equal(irAddr.toLowerCase(), deal.ir.toLowerCase());
    });

    it("compliance returns the deal MC address", async () => {
      const mcAddr = await token.compliance();
      assert.equal(mcAddr.toLowerCase(), deal.mc.toLowerCase());
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  5.2 Pause / Unpause
  // ═══════════════════════════════════════════════════════════════════

  describe("5.2 Pause / Unpause", () => {
    it("agent can pause the token", async () => {
      const receipt = await (await token.pause()).wait();
      const event = findEvent(receipt, token, "Paused");
      assert.ok(event, "Paused event not found");
      assert.equal(await token.paused(), true);
    });

    it("cannot pause when already paused", async () => {
      await assert.rejects(
        async () => { await token.pause(); },
        "pausing when already paused should revert"
      );
    });

    it("transfer blocked while paused", async () => {
      await assert.rejects(
        async () => { await token.transfer(aurora.address, 10n); },
        "transfer while paused should revert"
      );
    });

    it("agent can unpause the token", async () => {
      const receipt = await (await token.unpause()).wait();
      const event = findEvent(receipt, token, "Unpaused");
      assert.ok(event, "Unpaused event not found");
      assert.equal(await token.paused(), false);
    });

    it("cannot unpause when already unpaused", async () => {
      await assert.rejects(
        async () => { await token.unpause(); },
        "unpausing when already unpaused should revert"
      );
    });

    it("non-agent cannot pause or unpause", async () => {
      const tokenAsOutsider = token.connect(outsider);
      await assert.rejects(
        async () => { await tokenAsOutsider.pause(); },
        "non-agent should not pause"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  5.3 Mint
  // ═══════════════════════════════════════════════════════════════════

  describe("5.3 Mint", () => {
    it("agent can mint to whitelisted address", async () => {
      await (await token.mint(aurora.address, 500n)).wait();
      assert.equal(await token.balanceOf(aurora.address), 500n);
    });

    it("mint emits Transfer event from zero address", async () => {
      const receipt = await (await token.mint(northbridge.address, 200n)).wait();
      const event = findEvent(receipt, token, "Transfer");
      assert.ok(event, "Transfer event not found");
      assert.equal(event.args[0], ethers.ZeroAddress);
      assert.equal(event.args[1].toLowerCase(), northbridge.address.toLowerCase());
      assert.equal(event.args[2], 200n);
    });

    it("mint to non-whitelisted address reverts", async () => {
      await assert.rejects(
        async () => { await token.mint(outsider.address, 100n); },
        "minting to non-whitelisted should revert"
      );
    });

    it("non-agent cannot mint", async () => {
      const tokenAsOutsider = token.connect(outsider);
      await assert.rejects(
        async () => { await tokenAsOutsider.mint(aurora.address, 100n); },
        "non-agent should not mint"
      );
    });

    it("mint beyond supply limit reverts", async () => {
      const currentSupply = await token.totalSupply();
      const remaining = SUPPLY_LIMIT - currentSupply;
      await assert.rejects(
        async () => { await token.mint(aurora.address, remaining + 1n); },
        "minting beyond supply limit should revert"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  5.4 Transfer
  // ═══════════════════════════════════════════════════════════════════

  describe("5.4 Transfer", () => {
    it("transfer to whitelisted address succeeds", async () => {
      const before = await token.balanceOf(aurora.address);
      await (await token.transfer(aurora.address, 100n)).wait();
      assert.equal(await token.balanceOf(aurora.address), before + 100n);
    });

    it("transfer to non-whitelisted address reverts", async () => {
      await assert.rejects(
        async () => { await token.transfer(outsider.address, 10n); },
        "transfer to non-whitelisted should revert"
      );
    });

    it("transfer from frozen sender reverts", async () => {
      await (await token.setAddressFrozen(bndSafe.address, true)).wait();
      await assert.rejects(
        async () => { await token.transfer(aurora.address, 10n); },
        "frozen sender should not transfer"
      );
      await (await token.setAddressFrozen(bndSafe.address, false)).wait();
    });

    it("transfer to frozen receiver reverts", async () => {
      await (await token.setAddressFrozen(aurora.address, true)).wait();
      await assert.rejects(
        async () => { await token.transfer(aurora.address, 10n); },
        "transfer to frozen receiver should revert"
      );
      await (await token.setAddressFrozen(aurora.address, false)).wait();
    });

    it("transfer exceeding available balance reverts", async () => {
      const bal = await token.balanceOf(bndSafe.address);
      await assert.rejects(
        async () => { await token.transfer(aurora.address, bal + 1n); },
        "transfer exceeding balance should revert"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  5.5 TransferFrom (approval)
  // ═══════════════════════════════════════════════════════════════════

  describe("5.5 TransferFrom", () => {
    it("approve sets allowance correctly", async () => {
      await (await token.approve(aurora.address, 200n)).wait();
      assert.equal(await token.allowance(bndSafe.address, aurora.address), 200n);
    });

    it("transferFrom with approval succeeds", async () => {
      const tokenAsAurora = token.connect(aurora);
      const before = await token.balanceOf(northbridge.address);
      await (await tokenAsAurora.transferFrom(bndSafe.address, northbridge.address, 50n)).wait();
      assert.equal(await token.balanceOf(northbridge.address), before + 50n);
      assert.equal(await token.allowance(bndSafe.address, aurora.address), 150n);
    });

    it("transferFrom without approval reverts", async () => {
      const tokenAsNorthbridge = token.connect(northbridge);
      await assert.rejects(
        async () => {
          await tokenAsNorthbridge.transferFrom(bndSafe.address, northbridge.address, 10n);
        },
        "transferFrom without approval should revert"
      );
    });

    it("increaseAllowance and decreaseAllowance work", async () => {
      await (await token.approve(northbridge.address, 100n)).wait();
      assert.equal(await token.allowance(bndSafe.address, northbridge.address), 100n);

      await (await token.increaseAllowance(northbridge.address, 50n)).wait();
      assert.equal(await token.allowance(bndSafe.address, northbridge.address), 150n);

      await (await token.decreaseAllowance(northbridge.address, 30n)).wait();
      assert.equal(await token.allowance(bndSafe.address, northbridge.address), 120n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  5.6 Freeze
  // ═══════════════════════════════════════════════════════════════════

  describe("5.6 Freeze", () => {
    it("setAddressFrozen emits AddressFrozen event", async () => {
      const receipt = await (await token.setAddressFrozen(aurora.address, true)).wait();
      const event = findEvent(receipt, token, "AddressFrozen");
      assert.ok(event, "AddressFrozen event not found");
      assert.equal(await token.isFrozen(aurora.address), true);
      await (await token.setAddressFrozen(aurora.address, false)).wait();
    });

    it("freezePartialTokens restricts transferable balance", async () => {
      const auroraBalance = await token.balanceOf(aurora.address);
      const freezeAmount = auroraBalance - 10n;
      await (await token.freezePartialTokens(aurora.address, freezeAmount)).wait();
      assert.equal(await token.getFrozenTokens(aurora.address), freezeAmount);

      // aurora should be able to transfer only the free portion
      const tokenAsAurora = token.connect(aurora);
      await assert.rejects(
        async () => { await tokenAsAurora.transfer(northbridge.address, auroraBalance); },
        "should not transfer more than free balance"
      );

      // but can transfer the free portion
      await (await tokenAsAurora.transfer(northbridge.address, 10n)).wait();

      await (await token.unfreezePartialTokens(aurora.address, freezeAmount)).wait();
    });

    it("unfreezePartialTokens restores transferable balance", async () => {
      await (await token.freezePartialTokens(aurora.address, 100n)).wait();
      assert.equal(await token.getFrozenTokens(aurora.address), 100n);
      await (await token.unfreezePartialTokens(aurora.address, 100n)).wait();
      assert.equal(await token.getFrozenTokens(aurora.address), 0n);
    });

    it("freezePartialTokens exceeding available balance reverts", async () => {
      const bal = await token.balanceOf(aurora.address);
      await assert.rejects(
        async () => { await token.freezePartialTokens(aurora.address, bal + 1n); },
        "freezing more than balance should revert"
      );
    });

    it("unfreezePartialTokens exceeding frozen amount reverts", async () => {
      await assert.rejects(
        async () => { await token.unfreezePartialTokens(aurora.address, 1n); },
        "unfreezing more than frozen should revert"
      );
    });

    it("non-agent cannot freeze", async () => {
      const tokenAsOutsider = token.connect(outsider);
      await assert.rejects(
        async () => { await tokenAsOutsider.setAddressFrozen(aurora.address, true); },
        "non-agent should not freeze"
      );
      await assert.rejects(
        async () => { await tokenAsOutsider.freezePartialTokens(aurora.address, 10n); },
        "non-agent should not freeze partial"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  5.7 Burn
  // ═══════════════════════════════════════════════════════════════════

  describe("5.7 Burn", () => {
    it("agent can burn and reduces totalSupply", async () => {
      const supplyBefore = await token.totalSupply();
      const balBefore = await token.balanceOf(bndSafe.address);
      await (await token.burn(bndSafe.address, 100n)).wait();
      assert.equal(await token.totalSupply(), supplyBefore - 100n);
      assert.equal(await token.balanceOf(bndSafe.address), balBefore - 100n);
    });

    it("burn emits Transfer event to zero address", async () => {
      const receipt = await (await token.burn(bndSafe.address, 50n)).wait();
      const event = findEvent(receipt, token, "Transfer");
      assert.ok(event, "Transfer event not found");
      assert.equal(event.args[0].toLowerCase(), bndSafe.address.toLowerCase());
      assert.equal(event.args[1], ethers.ZeroAddress);
      assert.equal(event.args[2], 50n);
    });

    it("non-agent cannot burn", async () => {
      const tokenAsOutsider = token.connect(outsider);
      await assert.rejects(
        async () => { await tokenAsOutsider.burn(bndSafe.address, 10n); },
        "non-agent should not burn"
      );
    });

    it("burn more than balance reverts", async () => {
      const bal = await token.balanceOf(bndSafe.address);
      await assert.rejects(
        async () => { await token.burn(bndSafe.address, bal + 1n); },
        "burning more than balance should revert"
      );
    });

    it("burn unfreezes tokens if needed", async () => {
      const bal = await token.balanceOf(aurora.address);
      if (bal >= 100n) {
        await (await token.freezePartialTokens(aurora.address, 100n)).wait();
        assert.equal(await token.getFrozenTokens(aurora.address), 100n);
        await (await token.burn(aurora.address, bal)).wait();
        assert.equal(await token.balanceOf(aurora.address), 0n);
        assert.equal(await token.getFrozenTokens(aurora.address), 0n);
      } else {
        // if aurora has fewer tokens, freeze what we can and burn all
        if (bal > 0n) {
          await (await token.freezePartialTokens(aurora.address, bal)).wait();
          await (await token.burn(aurora.address, bal)).wait();
          assert.equal(await token.balanceOf(aurora.address), 0n);
          assert.equal(await token.getFrozenTokens(aurora.address), 0n);
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  5.8 ForcedTransfer
  // ═══════════════════════════════════════════════════════════════════

  describe("5.8 ForcedTransfer", () => {
    before(async () => {
      // ensure aurora has tokens for forced transfer tests
      const auroraBal = await token.balanceOf(aurora.address);
      if (auroraBal === 0n) {
        await (await token.mint(aurora.address, 500n)).wait();
      }
    });

    it("agent can forcedTransfer between whitelisted addresses", async () => {
      const before = await token.balanceOf(northbridge.address);
      await (await token.forcedTransfer(aurora.address, northbridge.address, 50n)).wait();
      assert.equal(await token.balanceOf(northbridge.address), before + 50n);
    });

    it("non-agent cannot forcedTransfer", async () => {
      const tokenAsOutsider = token.connect(outsider);
      await assert.rejects(
        async () => {
          await tokenAsOutsider.forcedTransfer(aurora.address, northbridge.address, 10n);
        },
        "non-agent should not forcedTransfer"
      );
    });

    it("forcedTransfer to non-whitelisted address reverts", async () => {
      await assert.rejects(
        async () => {
          await token.forcedTransfer(aurora.address, outsider.address, 10n);
        },
        "forcedTransfer to non-whitelisted should revert"
      );
    });

    it("forcedTransfer works when sender is frozen", async () => {
      await (await token.setAddressFrozen(aurora.address, true)).wait();
      const before = await token.balanceOf(northbridge.address);
      await (await token.forcedTransfer(aurora.address, northbridge.address, 10n)).wait();
      assert.equal(await token.balanceOf(northbridge.address), before + 10n);
      await (await token.setAddressFrozen(aurora.address, false)).wait();
    });

    it("forcedTransfer exceeding balance reverts", async () => {
      const bal = await token.balanceOf(aurora.address);
      await assert.rejects(
        async () => {
          await token.forcedTransfer(aurora.address, northbridge.address, bal + 1n);
        },
        "forcedTransfer exceeding balance should revert"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  5.9 Owner functions
  // ═══════════════════════════════════════════════════════════════════

  describe("5.9 Owner functions", () => {
    it("owner can setName and emits event", async () => {
      const tokenAsOwner = token.connect(platformAdmin);
      const receipt = await (await tokenAsOwner.setName("New Bond Name")).wait();
      const event = findEvent(receipt, token, "UpdatedTokenInformation");
      assert.ok(event, "UpdatedTokenInformation event not found");
      assert.equal(await token.name(), "New Bond Name");
      await (await tokenAsOwner.setName("ACME Corp / 3.875% Fixed EMTN")).wait();
    });

    it("owner can setSymbol and emits event", async () => {
      const tokenAsOwner = token.connect(platformAdmin);
      const receipt = await (await tokenAsOwner.setSymbol("NEW-SYM")).wait();
      const event = findEvent(receipt, token, "UpdatedTokenInformation");
      assert.ok(event, "UpdatedTokenInformation event not found");
      assert.equal(await token.symbol(), "NEW-SYM");
      await (await tokenAsOwner.setSymbol("TR-51X5RT-01")).wait();
    });

    it("owner can setOnchainID", async () => {
      const tokenAsOwner = token.connect(platformAdmin);
      const dummyId = randomAddress();
      await (await tokenAsOwner.setOnchainID(dummyId)).wait();
      assert.equal((await token.onchainID()).toLowerCase(), dummyId.toLowerCase());
      await (await tokenAsOwner.setOnchainID(ethers.ZeroAddress)).wait();
    });

    it("non-owner cannot setName", async () => {
      const tokenAsOutsider = token.connect(outsider);
      await assert.rejects(
        async () => { await tokenAsOutsider.setName("Hacked"); },
        "non-owner should not setName"
      );
    });

    it("non-owner cannot setSymbol", async () => {
      const tokenAsOutsider = token.connect(outsider);
      await assert.rejects(
        async () => { await tokenAsOutsider.setSymbol("HACK"); },
        "non-owner should not setSymbol"
      );
    });

    it("non-owner cannot setOnchainID", async () => {
      const tokenAsOutsider = token.connect(outsider);
      await assert.rejects(
        async () => { await tokenAsOutsider.setOnchainID(randomAddress()); },
        "non-owner should not setOnchainID"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  5.10 Fuzz tests
  // ═══════════════════════════════════════════════════════════════════

  describe("5.10 Fuzz tests", () => {
    it("random mint amounts stay within supply limit — 10 iterations", async () => {
      // burn everything from bndSafe first to have headroom
      const bndBal = await token.balanceOf(bndSafe.address);
      if (bndBal > 0n) await (await token.burn(bndSafe.address, bndBal)).wait();
      const nbBal = await token.balanceOf(northbridge.address);
      if (nbBal > 0n) await (await token.burn(northbridge.address, nbBal)).wait();
      const aurBal = await token.balanceOf(aurora.address);
      if (aurBal > 0n) await (await token.burn(aurora.address, aurBal)).wait();

      for (let i = 0; i < 10; i++) {
        const currentSupply = await token.totalSupply();
        const remaining = SUPPLY_LIMIT - currentSupply;
        if (remaining <= 0n) break;
        const amount = BigInt(Math.floor(Math.random() * Number(remaining))) + 1n;
        await (await token.mint(bndSafe.address, amount)).wait();
        assert.equal(await token.balanceOf(bndSafe.address) >= amount, true);
        // burn back to free headroom for next iteration
        await (await token.burn(bndSafe.address, amount)).wait();
      }
    });

    it("random transfer amounts — 10 iterations", async () => {
      await (await token.mint(bndSafe.address, 1000n)).wait();
      for (let i = 0; i < 10; i++) {
        const bal = await token.balanceOf(bndSafe.address);
        if (bal === 0n) break;
        const amount = BigInt(Math.floor(Math.random() * Number(bal))) + 1n;
        await (await token.transfer(aurora.address, amount)).wait();
        // transfer back
        const tokenAsAurora = token.connect(aurora);
        await (await tokenAsAurora.transfer(bndSafe.address, amount)).wait();
      }
      // cleanup
      const cleanBal = await token.balanceOf(bndSafe.address);
      if (cleanBal > 0n) await (await token.burn(bndSafe.address, cleanBal)).wait();
      const cleanAur = await token.balanceOf(aurora.address);
      if (cleanAur > 0n) await (await token.burn(aurora.address, cleanAur)).wait();
    });

    it("random freeze amounts — 10 iterations", async () => {
      await (await token.mint(bndSafe.address, 1000n)).wait();
      for (let i = 0; i < 10; i++) {
        const bal = await token.balanceOf(bndSafe.address);
        const frozen = await token.getFrozenTokens(bndSafe.address);
        const available = bal - frozen;
        if (available <= 0n) break;
        const freezeAmt = BigInt(Math.floor(Math.random() * Number(available))) + 1n;
        await (await token.freezePartialTokens(bndSafe.address, freezeAmt)).wait();
        const newFrozen = await token.getFrozenTokens(bndSafe.address);
        assert.equal(newFrozen, frozen + freezeAmt);
        // unfreeze immediately
        await (await token.unfreezePartialTokens(bndSafe.address, freezeAmt)).wait();
      }
      // cleanup
      const cleanBal = await token.balanceOf(bndSafe.address);
      if (cleanBal > 0n) await (await token.burn(bndSafe.address, cleanBal)).wait();
    });
  });
});
