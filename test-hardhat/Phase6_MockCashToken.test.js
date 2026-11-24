import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { network, artifacts } from "hardhat";
import { ethers } from "ethers";
import {
  setupProvider,
  getSigners,
  deployPlatform,
  findEvent,
} from "./helpers.js";

describe("Phase 6: MockCashToken", () => {
  let conn, provider;
  let deployer, aurora, northbridge, outsider;
  let cash;

  before(async () => {
    ({ conn, provider } = await setupProvider());
    const signers = await getSigners(provider);
    deployer = signers.deployer;
    aurora = signers.aurora;
    northbridge = signers.northbridge;
    outsider = signers.outsider;

    const platform = await deployPlatform(deployer);
    const cashArtifact = await artifacts.readArtifact("MockCashToken");
    cash = new ethers.Contract(await platform.cashToken.getAddress(), cashArtifact.abi, deployer);
  });

  after(async () => {
    // conn lifecycle managed by Hardhat 3.22+
  });

  // ═══════════════════════════════════════════════════════════════════
  //  6.1 Metadata
  // ═══════════════════════════════════════════════════════════════════

  describe("6.1 Metadata", () => {
    it("name is Euro Digital", async () => {
      assert.equal(await cash.name(), "Euro Digital");
    });

    it("symbol is EURd", async () => {
      assert.equal(await cash.symbol(), "EURd");
    });

    it("decimals is 6", async () => {
      assert.equal(await cash.decimals(), 6n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  6.2 Mint
  // ═══════════════════════════════════════════════════════════════════

  describe("6.2 Mint", () => {
    it("owner can mint tokens", async () => {
      await (await cash.mint(aurora.address, 1_000_000n)).wait();
      assert.equal(await cash.balanceOf(aurora.address), 1_000_000n);
    });

    it("non-owner cannot mint", async () => {
      const cashAsOutsider = cash.connect(outsider);
      await assert.rejects(
        async () => {
          await cashAsOutsider.mint(outsider.address, 100n);
        },
        "non-owner should not mint"
      );
    });

    it("mint updates recipient balance", async () => {
      const before = await cash.balanceOf(northbridge.address);
      await (await cash.mint(northbridge.address, 500_000n)).wait();
      const afterBal = await cash.balanceOf(northbridge.address);
      assert.equal(afterBal - before, 500_000n);
    });

    it("mint increases totalSupply", async () => {
      const supplyBefore = await cash.totalSupply();
      await (await cash.mint(aurora.address, 250_000n)).wait();
      const supplyAfter = await cash.totalSupply();
      assert.equal(supplyAfter - supplyBefore, 250_000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  6.3 ERC20 Transfer
  // ═══════════════════════════════════════════════════════════════════

  describe("6.3 ERC20 Transfer", () => {
    it("holder can transfer tokens", async () => {
      const cashAsAurora = cash.connect(aurora);
      const before = await cash.balanceOf(northbridge.address);
      await (await cashAsAurora.transfer(northbridge.address, 100_000n)).wait();
      const afterBal = await cash.balanceOf(northbridge.address);
      assert.equal(afterBal - before, 100_000n);
    });

    it("transfer to zero address reverts", async () => {
      const cashAsAurora = cash.connect(aurora);
      await assert.rejects(
        async () => {
          await cashAsAurora.transfer(ethers.ZeroAddress, 100n);
        },
        "transfer to zero address should revert"
      );
    });

    it("transfer with insufficient balance reverts", async () => {
      const cashAsOutsider = cash.connect(outsider);
      await assert.rejects(
        async () => {
          await cashAsOutsider.transfer(aurora.address, 1n);
        },
        "transfer without balance should revert"
      );
    });

    it("transfer emits Transfer event", async () => {
      const cashAsAurora = cash.connect(aurora);
      const receipt = await (await cashAsAurora.transfer(northbridge.address, 1000n)).wait();
      const event = findEvent(receipt, cash, "Transfer");
      assert.ok(event, "Transfer event not found");
      assert.equal(event.args[0].toLowerCase(), aurora.address.toLowerCase());
      assert.equal(event.args[1].toLowerCase(), northbridge.address.toLowerCase());
      assert.equal(event.args[2], 1000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  6.4 Approve & TransferFrom
  // ═══════════════════════════════════════════════════════════════════

  describe("6.4 Approve & TransferFrom", () => {
    it("approve sets allowance", async () => {
      const cashAsAurora = cash.connect(aurora);
      await (await cashAsAurora.approve(northbridge.address, 50_000n)).wait();
      assert.equal(await cash.allowance(aurora.address, northbridge.address), 50_000n);
    });

    it("transferFrom with approval succeeds", async () => {
      const cashAsNorthbridge = cash.connect(northbridge);
      const before = await cash.balanceOf(northbridge.address);
      await (await cashAsNorthbridge.transferFrom(aurora.address, northbridge.address, 30_000n)).wait();
      const afterBal = await cash.balanceOf(northbridge.address);
      assert.equal(afterBal - before, 30_000n);
    });

    it("transferFrom without approval reverts", async () => {
      const cashAsOutsider = cash.connect(outsider);
      await assert.rejects(
        async () => {
          await cashAsOutsider.transferFrom(aurora.address, outsider.address, 1n);
        },
        "transferFrom without approval should revert"
      );
    });

    it("allowance decreases after transferFrom", async () => {
      const remaining = await cash.allowance(aurora.address, northbridge.address);
      assert.equal(remaining, 20_000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  6.5 Fuzz tests
  // ═══════════════════════════════════════════════════════════════════

  describe("6.5 Fuzz tests", () => {
    it("random mint amounts — 10 iterations", async () => {
      for (let i = 0; i < 10; i++) {
        const amount = BigInt(Math.floor(Math.random() * 10_000_000)) + 1n;
        const before = await cash.balanceOf(aurora.address);
        await (await cash.mint(aurora.address, amount)).wait();
        const afterBal = await cash.balanceOf(aurora.address);
        assert.equal(afterBal - before, amount, `mint mismatch at iteration ${i}`);
      }
    });

    it("random transfer amounts — 10 iterations", async () => {
      const cashAsAurora = cash.connect(aurora);
      for (let i = 0; i < 10; i++) {
        const bal = await cash.balanceOf(aurora.address);
        if (bal === 0n) break;
        const amount = BigInt(Math.floor(Math.random() * Number(bal > 1000000n ? 1000000n : bal))) + 1n;
        const nbBefore = await cash.balanceOf(northbridge.address);
        await (await cashAsAurora.transfer(northbridge.address, amount)).wait();
        const nbAfter = await cash.balanceOf(northbridge.address);
        assert.equal(nbAfter - nbBefore, amount, `transfer mismatch at iteration ${i}`);
      }
    });

    it("random approve + transferFrom — 10 iterations", async () => {
      await (await cash.mint(aurora.address, 10_000_000n)).wait();
      const cashAsAurora = cash.connect(aurora);
      const cashAsNorthbridge = cash.connect(northbridge);
      for (let i = 0; i < 10; i++) {
        const amount = BigInt(Math.floor(Math.random() * 100_000)) + 1n;
        await (await cashAsAurora.approve(northbridge.address, amount)).wait();
        assert.equal(await cash.allowance(aurora.address, northbridge.address), amount);
        const before = await cash.balanceOf(northbridge.address);
        await (await cashAsNorthbridge.transferFrom(aurora.address, northbridge.address, amount)).wait();
        const afterBal = await cash.balanceOf(northbridge.address);
        assert.equal(afterBal - before, amount, `transferFrom mismatch at iteration ${i}`);
        assert.equal(await cash.allowance(aurora.address, northbridge.address), 0n);
      }
    });
  });
});
