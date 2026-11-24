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

describe("Phase 7: DVDTransferManager", () => {
  let conn, provider;
  let deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, outsider;
  let platform, deal;
  let dvd, token, cash, ir;
  let dvdAddr, tokenAddr, cashAddr;
  let cashAsAurora, dvdAsDeployer, dvdAsAurora, dvdAsOutsider;

  const BOND_MINT = 3000n;
  const CASH_MINT = 1_000_000n;

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

    ir = await getContractAt("IdentityRegistry", deal.ir, registrar);
    token = await getContractAt("Token", deal.token, bndSafe);
    cash = platform.cashToken;
    dvd = await getContractAt("DVDTransferManager", await platform.dvdManager.getAddress(), bndSafe);

    dvdAddr = await dvd.getAddress();
    tokenAddr = await token.getAddress();
    cashAddr = await cash.getAddress();

    // Pre-create connected instances to avoid mutation issues
    cashAsAurora = cash.connect(aurora);
    dvdAsDeployer = dvd.connect(deployer);
    dvdAsAurora = dvd.connect(aurora);
    dvdAsOutsider = dvd.connect(outsider);

    // Whitelist bndSafe and aurora
    await (await ir.registerIdentity(bndSafe.address, bndSafe.address, 356)).wait();
    await (await ir.registerIdentity(aurora.address, aurora.address, 840)).wait();

    // Unpause and mint bonds to bndSafe
    await (await token.unpause()).wait();
    await (await token.mint(bndSafe.address, BOND_MINT)).wait();

    // Mint cash to aurora
    await (await cash.mint(aurora.address, CASH_MINT)).wait();
  });

  after(async () => {
    // conn lifecycle managed by Hardhat 3.22+
  });

  // ═══════════════════════════════════════════════════════════════════
  //  7.1 View functions
  // ═══════════════════════════════════════════════════════════════════

  describe("7.1 View functions", () => {
    it("isTREX returns true for the bond token", async () => {
      assert.equal(await dvd.isTREX(tokenAddr), true);
    });

    it("isTREX returns false for the cash token (plain ERC-20)", async () => {
      assert.equal(await dvd.isTREX(cashAddr), false);
    });

    it("isTREXAgent returns true for bndSafe on bond token", async () => {
      assert.equal(await dvd.isTREXAgent(tokenAddr, bndSafe.address), true);
    });

    it("isTREXAgent returns false for outsider", async () => {
      assert.equal(await dvd.isTREXAgent(tokenAddr, outsider.address), false);
    });

    it("isTREXOwner returns true for platformAdmin on bond token", async () => {
      assert.equal(await dvd.isTREXOwner(tokenAddr, platformAdmin.address), true);
    });

    it("txNonce starts at 0", async () => {
      assert.equal(await dvd.txNonce(), 0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  7.2 calculateTransferID & calculateParity
  // ═══════════════════════════════════════════════════════════════════

  describe("7.2 calculateTransferID & calculateParity", () => {
    it("calculateTransferID is deterministic", async () => {
      const id1 = await dvd.calculateTransferID(0, bndSafe.address, tokenAddr, 100, aurora.address, cashAddr, 50000);
      const id2 = await dvd.calculateTransferID(0, bndSafe.address, tokenAddr, 100, aurora.address, cashAddr, 50000);
      assert.equal(id1, id2);
    });

    it("different nonce produces different transfer ID", async () => {
      const id1 = await dvd.calculateTransferID(0, bndSafe.address, tokenAddr, 100, aurora.address, cashAddr, 50000);
      const id2 = await dvd.calculateTransferID(1, bndSafe.address, tokenAddr, 100, aurora.address, cashAddr, 50000);
      assert.notEqual(id1, id2);
    });

    it("calculateParity is deterministic and order-sensitive", async () => {
      const p1 = await dvd.calculateParity(tokenAddr, cashAddr);
      const p2 = await dvd.calculateParity(tokenAddr, cashAddr);
      const p3 = await dvd.calculateParity(cashAddr, tokenAddr);
      assert.equal(p1, p2);
      assert.notEqual(p1, p3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  7.3 initiateDVDTransfer
  // ═══════════════════════════════════════════════════════════════════

  describe("7.3 initiateDVDTransfer", () => {
    const bondAmount = 100n;
    const cashAmount = 50_000n;
    let firstTransferNonce;

    it("agent can initiate and nonce increments", async () => {
      const tokenAsBnd = await getContractAt("Token", deal.token, bndSafe);
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      const nonceBefore = await dvdAsBnd.txNonce();
      firstTransferNonce = nonceBefore;
      await (await tokenAsBnd.approve(dvdAddr, bondAmount, { gasLimit: 100_000n })).wait();
      const receipt = await (await dvdAsBnd.initiateDVDTransfer(
        tokenAddr, bondAmount, aurora.address, cashAddr, cashAmount
      )).wait();
      const event = findEvent(receipt, dvd, "DVDTransferInitiated");
      assert.ok(event, "DVDTransferInitiated event not found");
      assert.equal(await dvdAsBnd.txNonce(), nonceBefore + 1n);
    });

    it("stores correct token1ToDeliver", async () => {
      const transferID = await dvd.calculateTransferID(
        firstTransferNonce, bndSafe.address, tokenAddr, bondAmount, aurora.address, cashAddr, cashAmount
      );
      const delivery = await dvd.token1ToDeliver(transferID);
      assert.equal(delivery[0].toLowerCase(), bndSafe.address.toLowerCase());
      assert.equal(delivery[1].toLowerCase(), tokenAddr.toLowerCase());
      assert.equal(delivery[2], bondAmount);
    });

    it("stores correct token2ToDeliver", async () => {
      const transferID = await dvd.calculateTransferID(
        firstTransferNonce, bndSafe.address, tokenAddr, bondAmount, aurora.address, cashAddr, cashAmount
      );
      const delivery = await dvd.token2ToDeliver(transferID);
      assert.equal(delivery[0].toLowerCase(), aurora.address.toLowerCase());
      assert.equal(delivery[1].toLowerCase(), cashAddr.toLowerCase());
      assert.equal(delivery[2], cashAmount);
    });

    it("non-agent cannot initiate", async () => {
      await assert.rejects(
        async () => {
          await dvdAsOutsider.initiateDVDTransfer(
            tokenAddr, 10, aurora.address, cashAddr, 5000
          );
        },
        "non-agent should not initiate"
      );
    });

    it("zero counterpart reverts", async () => {
      const tokenAsBnd = await getContractAt("Token", deal.token, bndSafe);
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await (await tokenAsBnd.approve(dvdAddr, 10n, { gasLimit: 100_000n })).wait();
      await assert.rejects(
        async () => {
          await dvdAsBnd.initiateDVDTransfer(
            tokenAddr, 10, ethers.ZeroAddress, cashAddr, 5000
          );
        },
        "zero counterpart should revert"
      );
    });

    it("insufficient bond balance reverts", async () => {
      const tokenAsBnd = await getContractAt("Token", deal.token, bndSafe);
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await (await tokenAsBnd.approve(dvdAddr, SUPPLY_LIMIT + 1n, { gasLimit: 100_000n })).wait();
      await assert.rejects(
        async () => {
          await dvdAsBnd.initiateDVDTransfer(
            tokenAddr, SUPPLY_LIMIT + 1n, aurora.address, cashAddr, 1
          );
        },
        "insufficient balance should revert"
      );
    });

    it("insufficient allowance reverts", async () => {
      const tokenAsBnd = await getContractAt("Token", deal.token, bndSafe);
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await (await tokenAsBnd.approve(dvdAddr, 0n, { gasLimit: 100_000n })).wait();
      await assert.rejects(
        async () => {
          await dvdAsBnd.initiateDVDTransfer(
            tokenAddr, 50, aurora.address, cashAddr, 25000
          );
        },
        "insufficient allowance should revert"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  7.4 takeDVDTransfer
  // ═══════════════════════════════════════════════════════════════════

  describe("7.4 takeDVDTransfer", () => {
    const bondAmt = 200n;
    const cashAmt = 100_000n;

    async function setupAndInitiate(bAmt, cAmt) {
      const tokenAsBnd = await getContractAt("Token", deal.token, bndSafe);
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await (await tokenAsBnd.approve(dvdAddr, bAmt, { gasLimit: 100_000n })).wait();
      const nonce = await dvdAsBnd.txNonce();
      await (await dvdAsBnd.initiateDVDTransfer(
        tokenAddr, bAmt, aurora.address, cashAddr, cAmt
      )).wait();
      const tid = await dvdAsBnd.calculateTransferID(
        nonce, bndSafe.address, tokenAddr, bAmt, aurora.address, cashAddr, cAmt
      );
      return tid;
    }

    it("agent can settle and emits DVDTransferExecuted", async () => {
      const tid = await setupAndInitiate(bondAmt, cashAmt);
      await (await cashAsAurora.approve(dvdAddr, cashAmt)).wait();

      const bndBondsBefore = await token.balanceOf(bndSafe.address);
      const auroraBondsBefore = await token.balanceOf(aurora.address);
      const bndCashBefore = await cash.balanceOf(bndSafe.address);
      const auroraCashBefore = await cash.balanceOf(aurora.address);

      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      const receipt = await (await dvdAsBnd.takeDVDTransfer(tid)).wait();
      const event = findEvent(receipt, dvd, "DVDTransferExecuted");
      assert.ok(event, "DVDTransferExecuted event not found");

      assert.equal(await token.balanceOf(bndSafe.address), bndBondsBefore - bondAmt);
      assert.equal(await token.balanceOf(aurora.address), auroraBondsBefore + bondAmt);
      assert.equal(await cash.balanceOf(bndSafe.address), bndCashBefore + cashAmt);
      assert.equal(await cash.balanceOf(aurora.address), auroraCashBefore - cashAmt);
    });

    it("transfer ID is deleted after execution (settling again reverts)", async () => {
      const tid = await setupAndInitiate(10n, 5_000n);
      await (await cashAsAurora.approve(dvdAddr, 5_000n)).wait();
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await (await dvdAsBnd.takeDVDTransfer(tid)).wait();
      await assert.rejects(
        async () => { await dvdAsBnd.takeDVDTransfer(tid); },
        "settling a deleted transfer should revert"
      );
    });

    it("non-agent cannot settle", async () => {
      const tid = await setupAndInitiate(10n, 5_000n);
      await assert.rejects(
        async () => { await dvdAsOutsider.takeDVDTransfer(tid); },
        "non-agent should not settle"
      );
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await (await dvdAsBnd.cancelDVDTransfer(tid)).wait();
    });

    it("reverts on non-existent transfer ID", async () => {
      const fakeID = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await assert.rejects(
        async () => { await dvdAsBnd.takeDVDTransfer(fakeID); },
        "non-existent ID should revert"
      );
    });

    it("reverts when counterpart has insufficient cash balance", async () => {
      const hugeCash = CASH_MINT * 10n;
      const tid = await setupAndInitiate(5n, hugeCash);
      await (await cashAsAurora.approve(dvdAddr, hugeCash)).wait();
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await assert.rejects(
        async () => { await dvdAsBnd.takeDVDTransfer(tid); },
        "insufficient cash balance should revert"
      );
      await (await dvdAsBnd.cancelDVDTransfer(tid)).wait();
    });

    it("reverts when counterpart has insufficient cash allowance", async () => {
      const tid = await setupAndInitiate(5n, 5_000n);
      await (await cashAsAurora.approve(dvdAddr, 0n)).wait();
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await assert.rejects(
        async () => { await dvdAsBnd.takeDVDTransfer(tid); },
        "insufficient allowance should revert"
      );
      await (await dvdAsBnd.cancelDVDTransfer(tid)).wait();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  7.5 cancelDVDTransfer
  // ═══════════════════════════════════════════════════════════════════

  describe("7.5 cancelDVDTransfer", () => {
    async function createTransfer(bondAmt, cashAmt) {
      const tokenAsBnd = await getContractAt("Token", deal.token, bndSafe);
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await (await tokenAsBnd.approve(dvdAddr, bondAmt, { gasLimit: 100_000n })).wait();
      const nonce = await dvdAsBnd.txNonce();
      await (await dvdAsBnd.initiateDVDTransfer(
        tokenAddr, bondAmt, aurora.address, cashAddr, cashAmt
      )).wait();
      return dvdAsBnd.calculateTransferID(
        nonce, bndSafe.address, tokenAddr, bondAmt, aurora.address, cashAddr, cashAmt
      );
    }

    it("maker (bndSafe) can cancel", async () => {
      const tid = await createTransfer(5n, 2500n);
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      const receipt = await (await dvdAsBnd.cancelDVDTransfer(tid)).wait();
      const event = findEvent(receipt, dvd, "DVDTransferCancelled");
      assert.ok(event, "DVDTransferCancelled event not found");
    });

    it("counterpart (aurora) can cancel", async () => {
      const tid = await createTransfer(5n, 2500n);
      const receipt = await (await dvdAsAurora.cancelDVDTransfer(tid)).wait();
      assert.ok(findEvent(receipt, dvd, "DVDTransferCancelled"));
    });

    it("DVD contract owner can cancel", async () => {
      const tid = await createTransfer(5n, 2500n);
      const receipt = await (await dvdAsDeployer.cancelDVDTransfer(tid)).wait();
      assert.ok(findEvent(receipt, dvd, "DVDTransferCancelled"));
    });

    it("random caller cannot cancel", async () => {
      const tid = await createTransfer(5n, 2500n);
      await assert.rejects(
        async () => { await dvdAsOutsider.cancelDVDTransfer(tid); },
        "random caller should not cancel"
      );
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await (await dvdAsBnd.cancelDVDTransfer(tid)).wait();
    });

    it("non-existent transferID reverts", async () => {
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      const fakeID = ethers.keccak256(ethers.toUtf8Bytes("doesnotexist"));
      await assert.rejects(
        async () => { await dvdAsBnd.cancelDVDTransfer(fakeID); },
        "non-existent transfer should revert"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  7.6 Integration
  // ═══════════════════════════════════════════════════════════════════

  describe("7.6 Integration", () => {
    async function dvdRoundTrip(bAmt, cAmt) {
      const tokenAsBnd = await getContractAt("Token", deal.token, bndSafe);
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await (await tokenAsBnd.approve(dvdAddr, bAmt, { gasLimit: 100_000n })).wait();
      const nonce = await dvdAsBnd.txNonce();
      await (await dvdAsBnd.initiateDVDTransfer(
        tokenAddr, bAmt, aurora.address, cashAddr, cAmt
      )).wait();
      const tid = await dvdAsBnd.calculateTransferID(
        nonce, bndSafe.address, tokenAddr, bAmt, aurora.address, cashAddr, cAmt
      );
      await (await cashAsAurora.approve(dvdAddr, cAmt)).wait();
      await (await dvdAsBnd.takeDVDTransfer(tid)).wait();
      return tid;
    }

    it("full end-to-end: initiate → take → verify final balances", async () => {
      const bondAmt = 50n;
      const cashAmt = 25_000n;

      const bndBondsBefore = await token.balanceOf(bndSafe.address);
      const auroraBondsBefore = await token.balanceOf(aurora.address);
      const bndCashBefore = await cash.balanceOf(bndSafe.address);
      const auroraCashBefore = await cash.balanceOf(aurora.address);

      await dvdRoundTrip(bondAmt, cashAmt);

      assert.equal(await token.balanceOf(bndSafe.address), bndBondsBefore - bondAmt);
      assert.equal(await token.balanceOf(aurora.address), auroraBondsBefore + bondAmt);
      assert.equal(await cash.balanceOf(bndSafe.address), bndCashBefore + cashAmt);
      assert.equal(await cash.balanceOf(aurora.address), auroraCashBefore - cashAmt);
    });

    it("initiate → cancel → verify no transfer happened", async () => {
      const bondAmt = 30n;
      const cashAmt = 15_000n;

      const bndBondsBefore = await token.balanceOf(bndSafe.address);
      const auroraCashBefore = await cash.balanceOf(aurora.address);

      const tokenAsBnd = await getContractAt("Token", deal.token, bndSafe);
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      await (await tokenAsBnd.approve(dvdAddr, bondAmt, { gasLimit: 100_000n })).wait();
      const nonce = await dvdAsBnd.txNonce();
      await (await dvdAsBnd.initiateDVDTransfer(
        tokenAddr, bondAmt, aurora.address, cashAddr, cashAmt
      )).wait();
      const tid = await dvdAsBnd.calculateTransferID(
        nonce, bndSafe.address, tokenAddr, bondAmt, aurora.address, cashAddr, cashAmt
      );

      await (await dvdAsBnd.cancelDVDTransfer(tid)).wait();

      assert.equal(await token.balanceOf(bndSafe.address), bndBondsBefore);
      assert.equal(await cash.balanceOf(aurora.address), auroraCashBefore);
    });

    it("multiple DVD transfers in sequence", async () => {
      const bondAmt = 20n;
      const cashAmt = 10_000n;
      const rounds = 3;

      const bndBondsBefore = await token.balanceOf(bndSafe.address);
      const auroraBondsBefore = await token.balanceOf(aurora.address);

      for (let i = 0; i < rounds; i++) {
        await dvdRoundTrip(bondAmt, cashAmt);
      }

      const totalBondsMoved = bondAmt * BigInt(rounds);
      assert.equal(await token.balanceOf(bndSafe.address), bndBondsBefore - totalBondsMoved);
      assert.equal(await token.balanceOf(aurora.address), auroraBondsBefore + totalBondsMoved);
      assert.equal(await token.totalSupply(), BOND_MINT);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  7.7 Fuzz tests
  // ═══════════════════════════════════════════════════════════════════

  describe("7.7 Fuzz tests", () => {
    it("10 random bond amounts: initiate → take round-trip", async () => {
      const tokenAsBnd = await getContractAt("Token", deal.token, bndSafe);
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      for (let i = 0; i < 10; i++) {
        const bondAmt = BigInt(Math.floor(Math.random() * 10) + 1);
        const cashAmt = bondAmt * 500n;

        const bndBefore = await token.balanceOf(bndSafe.address);
        const auBefore = await token.balanceOf(aurora.address);

        await (await tokenAsBnd.approve(dvdAddr, bondAmt, { gasLimit: 100_000n })).wait();
        const nonce = await dvdAsBnd.txNonce();
        await (await dvdAsBnd.initiateDVDTransfer(
          tokenAddr, bondAmt, aurora.address, cashAddr, cashAmt
        )).wait();
        const tid = await dvdAsBnd.calculateTransferID(
          nonce, bndSafe.address, tokenAddr, bondAmt, aurora.address, cashAddr, cashAmt
        );
        await (await cashAsAurora.approve(dvdAddr, cashAmt)).wait();
        await (await dvdAsBnd.takeDVDTransfer(tid)).wait();

        assert.equal(await token.balanceOf(bndSafe.address), bndBefore - bondAmt, `bond balance mismatch at ${i}`);
        assert.equal(await token.balanceOf(aurora.address), auBefore + bondAmt, `aurora balance mismatch at ${i}`);
      }
    });

    it("10 random cancel tests", async () => {
      const tokenAsBnd = await getContractAt("Token", deal.token, bndSafe);
      const dvdAsBnd = await getContractAt("DVDTransferManager", dvdAddr, bndSafe);
      for (let i = 0; i < 10; i++) {
        const bondAmt = BigInt(Math.floor(Math.random() * 5) + 1);
        const cashAmt = bondAmt * 300n;

        await (await tokenAsBnd.approve(dvdAddr, bondAmt, { gasLimit: 100_000n })).wait();
        const nonce = await dvdAsBnd.txNonce();
        await (await dvdAsBnd.initiateDVDTransfer(
          tokenAddr, bondAmt, aurora.address, cashAddr, cashAmt
        )).wait();
        const tid = await dvdAsBnd.calculateTransferID(
          nonce, bndSafe.address, tokenAddr, bondAmt, aurora.address, cashAddr, cashAmt
        );
        await (await dvdAsBnd.cancelDVDTransfer(tid)).wait();

        const delivery = await dvdAsBnd.token1ToDeliver(tid);
        assert.equal(delivery[0], ethers.ZeroAddress, `transfer not deleted at ${i}`);
      }
    });

    it("calculateTransferID uniqueness with 10 random inputs", async () => {
      const ids = new Set();
      for (let i = 0; i < 10; i++) {
        const nonce = BigInt(i);
        const maker = randomAddress();
        const taker = randomAddress();
        const amt1 = BigInt(Math.floor(Math.random() * 100000) + 1);
        const amt2 = BigInt(Math.floor(Math.random() * 100000) + 1);
        const id = await dvd.calculateTransferID(nonce, maker, tokenAddr, amt1, taker, cashAddr, amt2);
        assert.ok(!ids.has(id), `duplicate ID at iteration ${i}`);
        ids.add(id);
      }
    });
  });
});
