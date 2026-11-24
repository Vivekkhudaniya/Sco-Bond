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

const ZERO = ethers.ZeroAddress;

const CUSTOM_ERRORS = {
  OnlyTokenAgentCanCall: "OnlyTokenAgentCanCall(address)",
  OnlyTransferSenderCanCall: "OnlyTransferSenderCanCall(bytes32)",
  TokenIsNotRegistered: "TokenIsNotRegistered(address)",
  RecipientIsNotVerified: "RecipientIsNotVerified(address,address)",
  DVAManagerIsNotVerifiedForTheToken: "DVAManagerIsNotVerifiedForTheToken(address)",
  InvalidTransferID: "InvalidTransferID(bytes32)",
  TransferIsNotInPendingStatus: "TransferIsNotInPendingStatus(bytes32)",
  ApprovalsMustBeSequential: "ApprovalsMustBeSequential(bytes32)",
  ApproverNotFound: "ApproverNotFound(bytes32,address)",
  SignaturesCanNotBeEmpty: "SignaturesCanNotBeEmpty(bytes32)",
};

async function expectRevert(fn, reason) {
  let err;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected the call to revert, but it succeeded");
  if (reason && CUSTOM_ERRORS[reason]) {
    const selector = ethers.id(CUSTOM_ERRORS[reason]).slice(2, 10);
    const text = JSON.stringify(err.info ?? {}) + (err.data ?? "") + err.message;
    assert.ok(text.includes(selector), `expected custom error ${reason}, got: ${err.shortMessage ?? err.message}`);
  } else if (reason) {
    const text = [
      err.message,
      err.shortMessage,
      err.reason,
      err.revert?.name,
      err.revert?.args ? String(err.revert.args) : "",
      JSON.stringify(err.info ?? {}),
    ]
      .filter(Boolean)
      .join(" | ");
    assert.ok(text.includes(reason), `expected revert "${reason}", got: ${text}`);
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

describe("DvdDva", () => {
  let provider;
  let deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, meridian, outsider;
  let platform, cash, dvd, dvdAddr;

  before(async () => {
    ({ provider } = await setupProvider());
    ({ deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, meridian, outsider } =
      await getSigners(provider));
    platform = await deployPlatform(deployer);
    cash = platform.cashToken;
    dvd = platform.dvdManager;
    dvdAddr = await dvd.getAddress();
  });

  after(async () => {
    // shared connection: closed by process exit
  });

  /** Deploys a fresh deal, unpauses it and registers the given wallets. */
  async function newDeal(wallets, plat = platform) {
    const addrs = await deployDeal(
      plat.gateway,
      deployer,
      platformAdmin,
      registrar,
      bndSafe,
      plat.supplyLimitModule
    );
    const token = await getContractAt("Token", addrs.token, deployer);
    const ir = await getContractAt("IdentityRegistry", addrs.ir, registrar);
    if (await token.paused()) await (await token.connect(bndSafe).unpause()).wait();
    for (const w of wallets) {
      const id = await deployContract(deployer, "MockIdentityForIR");
      await (await ir.registerIdentity(w, await id.getAddress(), 356)).wait();
    }
    return { token, ir, addrs };
  }

  const mintBnd = async (token, to, amt) => (await token.connect(bndSafe).mint(to, amt)).wait();
  const mintCash = async (to, amt) => (await cash.connect(deployer).mint(to, amt)).wait();
  const bal = async (c, who) => c.balanceOf(typeof who === "string" ? who : who.address);

  // ═══════════════════════════════════════════════════════════════════
  //  MockCashToken
  // ═══════════════════════════════════════════════════════════════════

  describe("MockCashToken", () => {
    it("has name, symbol, 6 decimals and deployer as owner", async () => {
      assert.equal(await cash.name(), "Euro Digital");
      assert.equal(await cash.symbol(), "EURd");
      assert.equal(await cash.decimals(), 6n);
      assert.equal(await cash.owner(), deployer.address);
    });

    it("owner can mint and total supply grows", async () => {
      const before = await cash.totalSupply();
      const tx = await cash.connect(deployer).mint(outsider.address, 1234n);
      await tx.wait();
      assert.equal(await bal(cash, outsider), 1234n);
      assert.equal(await cash.totalSupply(), before + 1234n);
      const ev = await findEvent(tx, cash, "Transfer");
      assert.equal(ev.args[0], ZERO);
    });

    it("non-owner cannot mint", async () => {
      await expectRevert(
        async () => cash.connect(outsider).mint(outsider.address, 1n),
        "Ownable: caller is not the owner"
      );
    });

    it("fuzz: minted amounts accumulate per wallet", async () => {
      const rnd = prng(42);
      const w = ethers.Wallet.createRandom().address;
      let total = 0n;
      for (let i = 0; i < 10; i++) {
        const a = BigInt(Math.floor(rnd() * 1e9) + 1);
        total += a;
        await mintCash(w, a);
        assert.equal(await cash.balanceOf(w), total);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  DVDTransferManager
  // ═══════════════════════════════════════════════════════════════════

  describe("DVDTransferManager", () => {
    let token, tokenAddr, cashAddr, dealA;
    let emptyCash; // ERC20 with zero total supply

    before(async () => {
      dealA = await newDeal([bndSafe.address, aurora.address, northbridge.address, meridian.address]);
      token = dealA.token;
      tokenAddr = await token.getAddress();
      cashAddr = await cash.getAddress();
      await mintBnd(token, bndSafe.address, 3000n);
      await mintCash(aurora.address, 10n ** 12n);
      await mintCash(bndSafe.address, 10n ** 12n);
      await mintCash(northbridge.address, 10n ** 12n);
      emptyCash = await deployContract(deployer, "MockCashToken");
      await (await token.connect(bndSafe).approve(dvdAddr, ethers.MaxUint256)).wait();
      await (await cash.connect(aurora).approve(dvdAddr, ethers.MaxUint256)).wait();
      await (await cash.connect(bndSafe).approve(dvdAddr, ethers.MaxUint256)).wait();
    });

    /** bndSafe (maker) delivers `a1` bonds against `a2` cash from `cp`; returns the transferID. */
    async function initBond(a1, cp, a2, maker = bndSafe) {
      const tx = await dvd.connect(maker).initiateDVDTransfer(tokenAddr, a1, cp.address, cashAddr, a2);
      const ev = await findEvent(tx, dvd, "DVDTransferInitiated");
      return { id: ev.args[0], ev, tx };
    }

    const noFee = async () =>
      (await dvd.modifyFee(tokenAddr, cashAddr, 0, 0, 2, ZERO, ZERO)).wait();

    describe("views / pure helpers", () => {
      it("starts with nonce 0 semantic and deployer as owner", async () => {
        assert.equal(await dvd.owner(), deployer.address);
      });

      it("isTREX: true for deal token, false for ERC20 and for a token without identity registry", async () => {
        assert.equal(await dvd.isTREX(tokenAddr), true);
        assert.equal(await dvd.isTREX(cashAddr), false);
        const rawToken = await deployContract(deployer, "Token"); // uninitialised: IR == 0
        assert.equal(await dvd.isTREX(await rawToken.getAddress()), false);
      });

      it("isTREXAgent / isTREXOwner", async () => {
        assert.equal(await dvd.isTREXAgent(tokenAddr, bndSafe.address), true);
        assert.equal(await dvd.isTREXAgent(tokenAddr, outsider.address), false);
        assert.equal(await dvd.isTREXAgent(cashAddr, bndSafe.address), false);
        assert.equal(await dvd.isTREXOwner(tokenAddr, platformAdmin.address), true);
        assert.equal(await dvd.isTREXOwner(tokenAddr, outsider.address), false);
        assert.equal(await dvd.isTREXOwner(cashAddr, deployer.address), false);
      });

      it("calculateParity is directional and deterministic", async () => {
        const p = await dvd.calculateParity(tokenAddr, cashAddr);
        const expected = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [tokenAddr, cashAddr])
        );
        assert.equal(p, expected);
        assert.notEqual(p, await dvd.calculateParity(cashAddr, tokenAddr));
      });

      it("calculateTransferID matches keccak of abi.encode", async () => {
        const args = [7n, aurora.address, tokenAddr, 5n, northbridge.address, cashAddr, 9n];
        const expected = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256", "address", "address", "uint256", "address", "address", "uint256"],
            args
          )
        );
        assert.equal(await dvd.calculateTransferID(...args), expected);
      });

      it("calculateFee reverts for an unknown transfer", async () => {
        await expectRevert(
          async () => dvd.calculateFee(ethers.ZeroHash),
          "transfer ID does not exist"
        );
      });
    });

    describe("modifyFee", () => {
      it("owner sets fees; both parity and reflected parity are stored; two events", async () => {
        const tx = await dvd.modifyFee(tokenAddr, cashAddr, 1, 2, 3, meridian.address, northbridge.address);
        const receipt = await tx.wait();
        const events = receipt.logs
          .map((l) => {
            try {
              return dvd.interface.parseLog(l);
            } catch {
              return null;
            }
          })
          .filter((e) => e && e.name === "FeeModified");
        assert.equal(events.length, 2);
        assert.equal(events[0].args.fee1, 1n);
        assert.equal(events[1].args.fee1, 2n);

        const f = await dvd.fee(await dvd.calculateParity(tokenAddr, cashAddr));
        assert.equal(f.token1Fee, 1n);
        assert.equal(f.token2Fee, 2n);
        assert.equal(f.feeBase, 3n);
        assert.equal(f.fee1Wallet, meridian.address);
        assert.equal(f.fee2Wallet, northbridge.address);
        const r = await dvd.fee(await dvd.calculateParity(cashAddr, tokenAddr));
        assert.equal(r.token1Fee, 2n);
        assert.equal(r.token2Fee, 1n);
        assert.equal(r.fee1Wallet, northbridge.address);
        assert.equal(r.fee2Wallet, meridian.address);
        await noFee();
      });

      it("TREX owner of token1 may set fees", async () => {
        await (await dvd.connect(platformAdmin).modifyFee(tokenAddr, cashAddr, 0, 0, 2, ZERO, ZERO)).wait();
      });

      it("TREX owner of token2 may set fees (token1 is plain ERC20)", async () => {
        await (await dvd.connect(platformAdmin).modifyFee(cashAddr, tokenAddr, 0, 0, 2, ZERO, ZERO)).wait();
      });

      it("rejects callers that are neither DVD owner nor TREX owner", async () => {
        await expectRevert(
          async () => dvd.connect(outsider).modifyFee(tokenAddr, cashAddr, 0, 0, 2, ZERO, ZERO),
          "Ownable: only owner can call"
        );
        // bndSafe is a TREX agent, not owner
        await expectRevert(
          async () => dvd.connect(bndSafe).modifyFee(tokenAddr, cashAddr, 0, 0, 2, ZERO, ZERO),
          "Ownable: only owner can call"
        );
      });

      it("rejects tokens with zero total supply (token1 and token2)", async () => {
        const ea = await emptyCash.getAddress();
        await expectRevert(
          async () => dvd.modifyFee(ea, cashAddr, 0, 0, 2, ZERO, ZERO),
          "address is not an ERC20"
        );
        await expectRevert(
          async () => dvd.modifyFee(cashAddr, ea, 0, 0, 2, ZERO, ZERO),
          "address is not an ERC20"
        );
      });

      it("rejects invalid fee settings", async () => {
        const bad = (f1, f2, base) =>
          expectRevert(
            async () => dvd.modifyFee(tokenAddr, cashAddr, f1, f2, base, meridian.address, meridian.address),
            "invalid fee settings"
          );
        await bad(101, 0, 2); // fee1 > 10^base
        await bad(0, 101, 2); // fee2 > 10^base
        await bad(0, 0, 6); // base too high
        await bad(0, 0, 1); // base too low
        await bad(0, 0, 0);
      });

      it("accepts fee == 10^base boundary and base 5", async () => {
        await (await dvd.modifyFee(tokenAddr, cashAddr, 100, 100, 2, meridian.address, meridian.address)).wait();
        await (await dvd.modifyFee(tokenAddr, cashAddr, 1, 1, 5, meridian.address, meridian.address)).wait();
        await noFee();
      });

      it("requires non-zero fee wallets when fees are set", async () => {
        await expectRevert(
          async () => dvd.modifyFee(tokenAddr, cashAddr, 1, 0, 2, ZERO, meridian.address),
          "fee wallet 1 cannot be zero address"
        );
        await expectRevert(
          async () => dvd.modifyFee(tokenAddr, cashAddr, 0, 1, 2, meridian.address, ZERO),
          "fee wallet 2 cannot be zero address"
        );
      });
    });

    describe("initiateDVDTransfer", () => {
      it("stores both legs, emits event and increments nonce", async () => {
        const nonceBefore = await dvd.txNonce();
        const { id, ev } = await initBond(10n, aurora, 500n);
        assert.equal(await dvd.txNonce(), nonceBefore + 1n);
        const expectedId = await dvd.calculateTransferID(
          nonceBefore, bndSafe.address, tokenAddr, 10n, aurora.address, cashAddr, 500n
        );
        assert.equal(id, expectedId);
        assert.equal(ev.args.maker, bndSafe.address);
        assert.equal(ev.args.token1, tokenAddr);
        assert.equal(ev.args.token1Amount, 10n);
        assert.equal(ev.args.taker, aurora.address);
        assert.equal(ev.args.token2, cashAddr);
        assert.equal(ev.args.token2Amount, 500n);
        const t1 = await dvd.token1ToDeliver(id);
        const t2 = await dvd.token2ToDeliver(id);
        assert.equal(t1.counterpart, bndSafe.address);
        assert.equal(t1.token, tokenAddr);
        assert.equal(t1.amount, 10n);
        assert.equal(t2.counterpart, aurora.address);
        assert.equal(t2.token, cashAddr);
        assert.equal(t2.amount, 500n);
        await (await dvd.connect(bndSafe).cancelDVDTransfer(id)).wait();
      });

      it("allows an agent of token2 only (token1 is the cash leg)", async () => {
        const tx = await dvd.connect(bndSafe).initiateDVDTransfer(cashAddr, 5n, aurora.address, tokenAddr, 1n);
        const ev = await findEvent(tx, dvd, "DVDTransferInitiated");
        await (await dvd.connect(bndSafe).cancelDVDTransfer(ev.args[0])).wait();
      });

      it("rejects non-agents", async () => {
        await expectRevert(
          async () => dvd.connect(outsider).initiateDVDTransfer(tokenAddr, 1n, aurora.address, cashAddr, 1n),
          "only TREX agents can initiate transfers"
        );
      });

      it("rejects insufficient balance", async () => {
        await expectRevert(
          async () => dvd.connect(bndSafe).initiateDVDTransfer(tokenAddr, 10n ** 9n, aurora.address, cashAddr, 1n),
          "Not enough tokens in balance"
        );
      });

      it("rejects insufficient allowance", async () => {
        await (await token.connect(bndSafe).approve(dvdAddr, 0)).wait();
        await expectRevert(
          async () => dvd.connect(bndSafe).initiateDVDTransfer(tokenAddr, 1n, aurora.address, cashAddr, 1n),
          "not enough allowance to initiate transfer"
        );
        await (await token.connect(bndSafe).approve(dvdAddr, ethers.MaxUint256)).wait();
      });

      it("rejects zero counterpart", async () => {
        await expectRevert(
          async () => dvd.connect(bndSafe).initiateDVDTransfer(tokenAddr, 1n, ZERO, cashAddr, 1n),
          "counterpart cannot be null"
        );
      });

      it("rejects token2 without supply", async () => {
        await expectRevert(
          async () =>
            dvd
              .connect(bndSafe)
              .initiateDVDTransfer(tokenAddr, 1n, aurora.address, await emptyCash.getAddress(), 1n),
          "address is not an ERC20"
        );
      });
    });

    describe("takeDVDTransfer", () => {
      it("settles without fees: bonds to taker, cash to maker; transfer deleted; event", async () => {
        await noFee();
        const { id } = await initBond(100n, aurora, 1000n);
        const b0 = await bal(token, aurora), c0 = await bal(cash, bndSafe);
        const bs0 = await bal(token, bndSafe), ca0 = await bal(cash, aurora);
        const tx = await dvd.connect(bndSafe).takeDVDTransfer(id);
        const ev = await findEvent(tx, dvd, "DVDTransferExecuted");
        assert.equal(ev.args[0], id);
        assert.equal(await bal(token, aurora), b0 + 100n);
        assert.equal(await bal(token, bndSafe), bs0 - 100n);
        assert.equal(await bal(cash, bndSafe), c0 + 1000n);
        assert.equal(await bal(cash, aurora), ca0 - 1000n);
        assert.equal((await dvd.token1ToDeliver(id)).counterpart, ZERO);
        assert.equal((await dvd.token2ToDeliver(id)).counterpart, ZERO);
        await expectRevert(async () => dvd.connect(bndSafe).takeDVDTransfer(id), "transfer ID does not exist");
      });

      it("fee on token1 leg only", async () => {
        await (await dvd.modifyFee(tokenAddr, cashAddr, 10, 0, 2, meridian.address, ZERO)).wait();
        const { id } = await initBond(100n, aurora, 1000n);
        const fees = await dvd.calculateFee(id);
        assert.equal(fees.txFee1, 10n);
        assert.equal(fees.txFee2, 0n);
        const a0 = await bal(token, aurora), m0 = await bal(token, meridian);
        await (await dvd.connect(bndSafe).takeDVDTransfer(id)).wait();
        assert.equal(await bal(token, aurora), a0 + 90n);
        assert.equal(await bal(token, meridian), m0 + 10n);
        await noFee();
      });

      it("fee on token2 leg only", async () => {
        await (await dvd.modifyFee(tokenAddr, cashAddr, 0, 5, 2, ZERO, northbridge.address)).wait();
        const { id } = await initBond(100n, aurora, 1000n);
        const n0 = await bal(cash, northbridge), b0 = await bal(cash, bndSafe);
        await (await dvd.connect(bndSafe).takeDVDTransfer(id)).wait();
        assert.equal(await bal(cash, northbridge), n0 + 50n);
        assert.equal(await bal(cash, bndSafe), b0 + 950n);
        await noFee();
      });

      it("fees on both legs", async () => {
        await (await dvd.modifyFee(tokenAddr, cashAddr, 10, 5, 2, meridian.address, northbridge.address)).wait();
        const { id } = await initBond(200n, aurora, 2000n);
        const m0 = await bal(token, meridian), n0 = await bal(cash, northbridge);
        await (await dvd.connect(bndSafe).takeDVDTransfer(id)).wait();
        assert.equal(await bal(token, meridian), m0 + 20n);
        assert.equal(await bal(cash, northbridge), n0 + 100n);
        await noFee();
      });

      it("fee rate with base 3 follows the contract formula (amount*fee*10^(base-2)/10^base)", async () => {
        await (await dvd.modifyFee(tokenAddr, cashAddr, 0, 25, 3, ZERO, northbridge.address)).wait();
        const { id } = await initBond(10n, aurora, 1000n);
        const fees = await dvd.calculateFee(id);
        assert.equal(fees.txFee2, (1000n * 25n * 10n) / 1000n);
        await (await dvd.connect(bndSafe).takeDVDTransfer(id)).wait();
        await noFee();
      });

      it("a fee larger than the leg amount makes execution revert (underflow)", async () => {
        await (await dvd.modifyFee(tokenAddr, cashAddr, 0, 1000, 4, ZERO, northbridge.address)).wait();
        const { id } = await initBond(10n, aurora, 1000n);
        await expectRevert(async () => dvd.connect(bndSafe).takeDVDTransfer(id));
        await (await dvd.connect(bndSafe).cancelDVDTransfer(id)).wait();
        await noFee();
      });

      it("agent of token2 only may execute (cash leg first)", async () => {
        const tx = await dvd.connect(bndSafe).initiateDVDTransfer(cashAddr, 300n, aurora.address, tokenAddr, 20n);
        const ev = await findEvent(tx, dvd, "DVDTransferInitiated");
        // aurora (taker) holds bonds from earlier settlements and must approve the DVD manager
        await (await token.connect(aurora).approve(dvdAddr, ethers.MaxUint256)).wait();
        await (await dvd.connect(bndSafe).takeDVDTransfer(ev.args[0])).wait();
      });

      it("a second TREX agent (not the maker) may execute", async () => {
        await (await token.connect(platformAdmin).addAgent(northbridge.address)).wait();
        const { id } = await initBond(5n, aurora, 50n);
        await (await dvd.connect(northbridge).takeDVDTransfer(id)).wait();
      });

      it("rejects unknown IDs, non-agents, low balance and low allowance", async () => {
        await expectRevert(
          async () => dvd.connect(bndSafe).takeDVDTransfer(ethers.ZeroHash),
          "transfer ID does not exist"
        );

        const { id } = await initBond(5n, aurora, 50n);
        await expectRevert(
          async () => dvd.connect(outsider).takeDVDTransfer(id),
          "only TREX agents can execute transfers"
        );
        // the taker itself (not an agent) cannot execute either
        await expectRevert(
          async () => dvd.connect(aurora).takeDVDTransfer(id),
          "only TREX agents can execute transfers"
        );
        await (await dvd.connect(bndSafe).cancelDVDTransfer(id)).wait();

        // low taker balance
        const poor = await initBond(5n, meridian, 10n ** 6n);
        await expectRevert(
          async () => dvd.connect(bndSafe).takeDVDTransfer(poor.id),
          "Not enough tokens in balance"
        );
        await (await dvd.connect(bndSafe).cancelDVDTransfer(poor.id)).wait();

        // low taker allowance
        await (await cash.connect(aurora).approve(dvdAddr, 0)).wait();
        const noAllow = await initBond(5n, aurora, 50n);
        await expectRevert(
          async () => dvd.connect(bndSafe).takeDVDTransfer(noAllow.id),
          "not enough allowance to transfer"
        );
        await (await dvd.connect(bndSafe).cancelDVDTransfer(noAllow.id)).wait();
        await (await cash.connect(aurora).approve(dvdAddr, ethers.MaxUint256)).wait();
      });

      it("fails when the TREX leg breaks identity rules (taker not verified)", async () => {
        await mintCash(outsider.address, 1000n);
        await (await cash.connect(outsider).approve(dvdAddr, 1000n)).wait();
        const { id } = await initBond(5n, outsider, 100n);
        await expectRevert(async () => dvd.connect(bndSafe).takeDVDTransfer(id), "Transfer not possible");
        await (await dvd.connect(bndSafe).cancelDVDTransfer(id)).wait();
      });
    });

    describe("cancelDVDTransfer", () => {
      it("maker, taker, DVD owner, and TREX agents can cancel; emits event", async () => {
        // maker
        let { id } = await initBond(1n, aurora, 10n);
        const tx = await dvd.connect(bndSafe).cancelDVDTransfer(id);
        const ev = await findEvent(tx, dvd, "DVDTransferCancelled");
        assert.equal(ev.args[0], id);
        assert.equal((await dvd.token1ToDeliver(id)).counterpart, ZERO);

        // taker
        ({ id } = await initBond(1n, aurora, 10n));
        await (await dvd.connect(aurora).cancelDVDTransfer(id)).wait();

        // DVD owner
        ({ id } = await initBond(1n, aurora, 10n));
        await (await dvd.connect(deployer).cancelDVDTransfer(id)).wait();

        // second agent of token1 (northbridge, registered as agent earlier; not maker nor taker)
        ({ id } = await initBond(1n, aurora, 10n));
        await (await dvd.connect(northbridge).cancelDVDTransfer(id)).wait();

        // agent of token2 only: token1 = cash
        const t = await dvd.connect(bndSafe).initiateDVDTransfer(cashAddr, 1n, aurora.address, tokenAddr, 1n);
        const e2 = await findEvent(t, dvd, "DVDTransferInitiated");
        await (await dvd.connect(northbridge).cancelDVDTransfer(e2.args[0])).wait();
      });

      it("rejects unknown IDs and unauthorised callers", async () => {
        await expectRevert(
          async () => dvd.connect(bndSafe).cancelDVDTransfer(ethers.ZeroHash),
          "transfer ID does not exist"
        );
        const { id } = await initBond(1n, aurora, 10n);
        await expectRevert(
          async () => dvd.connect(outsider).cancelDVDTransfer(id),
          "you are not allowed to cancel this transfer"
        );
        await (await dvd.connect(bndSafe).cancelDVDTransfer(id)).wait();
        await expectRevert(async () => dvd.connect(bndSafe).cancelDVDTransfer(id), "transfer ID does not exist");
      });
    });

    describe("fuzz: DVD settlement with random fees", () => {
      it("balances always follow the fee formula", async () => {
        const rnd = prng(2024);
        for (let i = 0; i < 8; i++) {
          const base = 2 + Math.floor(rnd() * 4);
          const f1 = BigInt(Math.floor(rnd() * 101));
          const f2 = BigInt(Math.floor(rnd() * 101));
          const a1 = BigInt(Math.floor(rnd() * 50) + 1);
          const a2 = BigInt(Math.floor(rnd() * 1e6) + 1);
          await (
            await dvd.modifyFee(tokenAddr, cashAddr, f1, f2, base, meridian.address, northbridge.address)
          ).wait();
          const scale = 10n ** BigInt(base - 2);
          const d = 10n ** BigInt(base);
          const fee1 = (a1 * f1 * scale) / d;
          const fee2 = (a2 * f2 * scale) / d;
          const { id } = await initBond(a1, aurora, a2);
          const fees = await dvd.calculateFee(id);
          assert.equal(fees.txFee1, fee1);
          assert.equal(fees.txFee2, fee2);

          const bondA = await bal(token, aurora), bondM = await bal(token, meridian);
          const cashB = await bal(cash, bndSafe), cashN = await bal(cash, northbridge);
          await (await dvd.connect(bndSafe).takeDVDTransfer(id)).wait();
          assert.equal(await bal(token, aurora), bondA + a1 - fee1);
          assert.equal(await bal(token, meridian), bondM + fee1);
          assert.equal(await bal(cash, bndSafe), cashB + a2 - fee2);
          assert.equal(await bal(cash, northbridge), cashN + fee2);
        }
        await noFee();
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  DVATransferManager
  // ═══════════════════════════════════════════════════════════════════

  describe("DVATransferManager", () => {
    let dva, dvaAddr, token, tokenAddr, ir;
    let unregisteredToken;
    const AMT = 10n;
    const G = { gasLimit: 3_000_000 };

    before(async () => {
      dva = await deployContract(deployer, "DVATransferManager");
      dvaAddr = await dva.getAddress();
      const d = await newDeal(
        [bndSafe.address, aurora.address, northbridge.address, meridian.address],
        await deployPlatform(deployer)
      );
      token = d.token;
      ir = d.ir;
      tokenAddr = await token.getAddress();
      unregisteredToken = cash;
      await mintBnd(token, aurora.address, 3000n);
      await (await token.connect(aurora).approve(dvaAddr, ethers.MaxUint256)).wait();
    });

    const setCrit = (rec, agent, seq, extra, signer = bndSafe) =>
      dva.connect(signer).setApprovalCriteria(tokenAddr, rec, agent, seq, extra).then((t) => t.wait());

    async function initTransfer(recipient = northbridge, amount = AMT) {
      const nonce = await dva.getNextTxNonce();
      const tx = await dva
        .connect(aurora)
        .initiateTransfer(tokenAddr, recipient.address, amount, { gasLimit: 3_000_000 });
      const ev = await findEvent(tx, dva, "TransferInitiated");
      assert.equal(ev.args[0], await dva.calculateTransferID(nonce, aurora.address, recipient.address, amount));
      return ev.args[0];
    }

    const status = async (id) => (await dva.getTransfer(id)).status;
    const PENDING = 0n, COMPLETED = 1n, CANCELLED = 2n, REJECTED = 3n;

    async function sign(signer, id) {
      const sig = ethers.Signature.from(await signer.signMessage(ethers.getBytes(id)));
      return { v: sig.v, r: sig.r, s: sig.s };
    }

    describe("pure / view basics", () => {
      it("name, initial nonce, calculateTransferID", async () => {
        assert.equal(await dva.name(), "DVATransferManager");
        assert.equal(await dva.getNextTxNonce(), 0n);
        const expected = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256", "address", "address", "uint256"],
            [3n, aurora.address, northbridge.address, 4n]
          )
        );
        assert.equal(await dva.calculateTransferID(3n, aurora.address, northbridge.address, 4n), expected);
      });

      it("getApprovalCriteria / initiateTransfer revert for an unregistered token", async () => {
        const t = await unregisteredToken.getAddress();
        await expectRevert(async () => dva.getApprovalCriteria(t), "TokenIsNotRegistered");
        await expectRevert(
          async () => dva.connect(aurora).initiateTransfer(t, northbridge.address, 1n),
          "TokenIsNotRegistered"
        );
      });

      it("getTransfer / getNextApprover revert for unknown IDs", async () => {
        await expectRevert(async () => dva.getTransfer(ethers.ZeroHash), "InvalidTransferID");
        await expectRevert(async () => dva.getNextApprover(ethers.ZeroHash), "InvalidTransferID");
      });
    });

    describe("setApprovalCriteria", () => {
      it("only token agents can call", async () => {
        await expectRevert(
          async () => dva.connect(outsider).setApprovalCriteria(tokenAddr, true, true, false, []),
          "OnlyTokenAgentCanCall"
        );
      });

      it("reverts while the DVA manager is not verified in the identity registry", async () => {
        await expectRevert(
          async () => dva.connect(bndSafe).setApprovalCriteria(tokenAddr, true, true, false, []),
          "DVAManagerIsNotVerifiedForTheToken"
        );
      });

      it("succeeds once the manager is registered; stores criteria and emits event", async () => {
        const id = await deployContract(deployer, "MockIdentityForIR");
        await (await ir.registerIdentity(dvaAddr, await id.getAddress(), 356)).wait();

        const tx = await dva
          .connect(bndSafe)
          .setApprovalCriteria(tokenAddr, true, true, false, [meridian.address]);
        const ev = await findEvent(tx, dva, "ApprovalCriteriaSet");
        const expectedHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "bool", "bool", "address[]"],
            [tokenAddr, true, true, [meridian.address]]
          )
        );
        assert.equal(ev.args.hash, expectedHash);
        assert.equal(ev.args.sequentialApproval, false);
        const c = await dva.getApprovalCriteria(tokenAddr);
        assert.equal(c.includeRecipientApprover, true);
        assert.equal(c.includeAgentApprover, true);
        assert.equal(c.sequentialApproval, false);
        assert.deepEqual([...c.additionalApprovers], [meridian.address]);
        assert.equal(c.hash, expectedHash);
      });
    });

    describe("initiateTransfer", () => {
      it("escrows tokens, builds approver list, emits event and bumps nonce", async () => {
        await setCrit(true, true, false, [meridian.address]);
        const nonce = await dva.getNextTxNonce();
        const before = await bal(token, aurora);
        const id = await initTransfer();
        assert.equal(await dva.getNextTxNonce(), nonce + 1n);
        assert.equal(await bal(token, aurora), before - AMT);
        assert.equal(await bal(token, dvaAddr), AMT);
        const t = await dva.getTransfer(id);
        assert.equal(t.tokenAddress, tokenAddr);
        assert.equal(t.sender, aurora.address);
        assert.equal(t.recipient, northbridge.address);
        assert.equal(t.amount, AMT);
        assert.equal(t.status, PENDING);
        assert.equal(t.approvers.length, 3);
        assert.equal(t.approvers[0].wallet, northbridge.address);
        assert.equal(t.approvers[1].wallet, ZERO);
        assert.equal(t.approvers[1].anyTokenAgent, true);
        assert.equal(t.approvers[2].wallet, meridian.address);
        assert.equal(t.approvalCriteriaHash, (await dva.getApprovalCriteria(tokenAddr)).hash);
        // clean up
        await (await dva.connect(aurora).cancelTransfer(id)).wait();
      });

      it("rejects unverified recipients", async () => {
        await expectRevert(
          async () => dva.connect(aurora).initiateTransfer(tokenAddr, outsider.address, 1n),
          "RecipientIsNotVerified"
        );
      });

      it("reverts when sender has no allowance / balance (token transferFrom fails)", async () => {
        await expectRevert(async () => dva.connect(northbridge).initiateTransfer(tokenAddr, meridian.address, 1n));
      });
    });

    describe("approveTransfer", () => {
      it("recipient-only criteria: single approval completes the transfer", async () => {
        await setCrit(true, false, false, []);
        const id = await initTransfer();
        assert.deepEqual([...(await dva.getNextApprover(id))], [northbridge.address, false]);
        const rBefore = await bal(token, northbridge);
        const tx = await dva.connect(northbridge).approveTransfer(id, G);
        assert.ok(await findEvent(tx, dva, "TransferApproved"));
        const done = await findEvent(tx, dva, "TransferCompleted");
        assert.equal(done.args.recipient, northbridge.address);
        assert.equal(done.args.amount, AMT);
        assert.equal(await status(id), COMPLETED);
        assert.equal(await bal(token, northbridge), rBefore + AMT);
        await expectRevert(async () => dva.connect(northbridge).approveTransfer(id, G), "TransferIsNotInPendingStatus");
        await expectRevert(async () => dva.getNextApprover(id), "TransferIsNotInPendingStatus");
      });

      it("non-sequential: approvers may approve in any order; pending ones are counted", async () => {
        await setCrit(true, true, false, [meridian.address]);
        const id = await initTransfer();
        // agent (middle) approves first: wallet slot gets filled with the caller
        const tx1 = await dva.connect(bndSafe).approveTransfer(id, G);
        assert.equal((await findEvent(tx1, dva, "TransferApproved")).args.approver, bndSafe.address);
        assert.equal(await status(id), PENDING);
        assert.equal((await dva.getTransfer(id)).approvers[1].wallet, bndSafe.address);
        assert.deepEqual([...(await dva.getNextApprover(id))], [northbridge.address, false]);
        // last approver next
        await (await dva.connect(meridian).approveTransfer(id, G)).wait();
        assert.equal(await status(id), PENDING);
        // recipient completes
        const tx3 = await dva.connect(northbridge).approveTransfer(id, G);
        assert.ok(await findEvent(tx3, dva, "TransferCompleted"));
        assert.equal(await status(id), COMPLETED);
      });

      it("non-sequential: first approver approving leaves later ones pending", async () => {
        const id = await initTransfer();
        await (await dva.connect(northbridge).approveTransfer(id, G)).wait();
        assert.deepEqual([...(await dva.getNextApprover(id))], [ZERO, true]);
        await (await dva.connect(bndSafe).approveTransfer(id, G)).wait();
        assert.deepEqual([...(await dva.getNextApprover(id))], [meridian.address, false]);
        await (await dva.connect(meridian).approveTransfer(id, G)).wait();
        assert.equal(await status(id), COMPLETED);
      });

      it("rejects callers that are not approvers (incl. non-agent for the agent slot)", async () => {
        const id = await initTransfer();
        await expectRevert(async () => dva.connect(outsider).approveTransfer(id, G), "ApproverNotFound");
        // an approver cannot approve twice
        await (await dva.connect(northbridge).approveTransfer(id, G)).wait();
        await expectRevert(async () => dva.connect(northbridge).approveTransfer(id, G), "ApproverNotFound");
        await (await dva.connect(aurora).cancelTransfer(id)).wait();
      });

      it("sequential: out of order reverts, in order completes", async () => {
        await setCrit(true, true, true, [meridian.address]);
        const id = await initTransfer();
        await expectRevert(async () => dva.connect(bndSafe).approveTransfer(id, G), "ApprovalsMustBeSequential");
        await expectRevert(async () => dva.connect(meridian).approveTransfer(id, G), "ApprovalsMustBeSequential");
        await (await dva.connect(northbridge).approveTransfer(id, G)).wait();
        await expectRevert(async () => dva.connect(meridian).approveTransfer(id, G), "ApprovalsMustBeSequential");
        await (await dva.connect(bndSafe).approveTransfer(id, G)).wait();
        await (await dva.connect(meridian).approveTransfer(id, G)).wait();
        assert.equal(await status(id), COMPLETED);
      });

      it("unknown transfer ID", async () => {
        await expectRevert(async () => dva.connect(northbridge).approveTransfer(ethers.ZeroHash), "InvalidTransferID");
      });

      it("criteria change resets approvals instead of approving", async () => {
        await setCrit(true, false, false, []);
        const id = await initTransfer();
        await setCrit(false, true, false, []); // new criteria: agent only
        const tx = await dva.connect(northbridge).approveTransfer(id, G);
        const reset = await findEvent(tx, dva, "TransferApprovalStateReset");
        assert.ok(reset);
        assert.equal(reset.args.approvalCriteriaHash, (await dva.getApprovalCriteria(tokenAddr)).hash);
        assert.equal(await status(id), PENDING);
        const t = await dva.getTransfer(id);
        assert.equal(t.approvers.length, 1);
        assert.equal(t.approvers[0].anyTokenAgent, true);
        // approver list is now only the agent
        await (await dva.connect(bndSafe).approveTransfer(id, G)).wait();
        assert.equal(await status(id), COMPLETED);
      });

      it("transfer with no approvers cannot be approved but can be cancelled", async () => {
        await setCrit(false, false, false, []);
        const id = await initTransfer();
        assert.deepEqual([...(await dva.getNextApprover(id))], [ZERO, false]);
        await expectRevert(async () => dva.connect(northbridge).approveTransfer(id, G), "ApproverNotFound");
        await (await dva.connect(aurora).cancelTransfer(id)).wait();
      });
    });

    describe("delegateApproveTransfer", () => {
      it("rejects an empty signature list", async () => {
        await expectRevert(
          async () => dva.connect(outsider).delegateApproveTransfer(ethers.ZeroHash, []),
          "SignaturesCanNotBeEmpty"
        );
      });

      it("unknown / non-pending transfers revert", async () => {
        const s = await sign(northbridge, ethers.ZeroHash);
        await expectRevert(
          async () => dva.connect(outsider).delegateApproveTransfer(ethers.ZeroHash, [s]),
          "InvalidTransferID"
        );
      });

      it("approvals via signatures complete the transfer once all approvers signed", async () => {
        await setCrit(true, true, true, []);
        const id = await initTransfer();
        const sigs = [await sign(northbridge, id), await sign(bndSafe, id)];
        const rBefore = await bal(token, northbridge);
        // a relayer (outsider) submits both signatures
        const tx = await dva.connect(outsider).delegateApproveTransfer(id, sigs);
        assert.ok(await findEvent(tx, dva, "TransferCompleted"));
        assert.equal(await status(id), COMPLETED);
        assert.equal(await bal(token, northbridge), rBefore + AMT);
        await expectRevert(
          async () => dva.connect(outsider).delegateApproveTransfer(id, sigs),
          "TransferIsNotInPendingStatus"
        );
      });

      it("partial signatures leave the transfer pending", async () => {
        const id = await initTransfer();
        await (await dva.connect(outsider).delegateApproveTransfer(id, [await sign(northbridge, id)])).wait();
        assert.equal(await status(id), PENDING);
        assert.deepEqual([...(await dva.getNextApprover(id))], [ZERO, true]);
        await (await dva.connect(aurora).cancelTransfer(id)).wait();
      });

      it("signature from a non-approver reverts (sequential order enforced)", async () => {
        const id = await initTransfer();
        await expectRevert(
          async () => dva.connect(outsider).delegateApproveTransfer(id, [await sign(bndSafe, id)]),
          "ApprovalsMustBeSequential"
        );
        await expectRevert(
          async () => dva.connect(outsider).delegateApproveTransfer(id, [await sign(outsider, id)]),
          "ApprovalsMustBeSequential"
        );
        await (await dva.connect(aurora).cancelTransfer(id)).wait();
      });

      it("signature from a non-approver reverts with ApproverNotFound (non-sequential)", async () => {
        await setCrit(true, false, false, []);
        const id = await initTransfer();
        await expectRevert(
          async () => dva.connect(outsider).delegateApproveTransfer(id, [await sign(outsider, id)]),
          "ApproverNotFound"
        );
        await (await dva.connect(aurora).cancelTransfer(id)).wait();
      });

      it("criteria change resets state instead of applying signatures", async () => {
        await setCrit(true, false, false, []);
        const id = await initTransfer();
        await setCrit(true, true, false, []);
        const tx = await dva.connect(outsider).delegateApproveTransfer(id, [await sign(northbridge, id)]);
        assert.ok(await findEvent(tx, dva, "TransferApprovalStateReset"));
        assert.equal(await status(id), PENDING);
        assert.equal((await dva.getTransfer(id)).approvers.length, 2);
        await (await dva.connect(aurora).cancelTransfer(id)).wait();
      });
    });

    describe("cancelTransfer", () => {
      it("sender cancels and gets tokens back", async () => {
        await setCrit(true, false, false, []);
        const before = await bal(token, aurora);
        const id = await initTransfer();
        assert.equal(await bal(token, aurora), before - AMT);
        const tx = await dva.connect(aurora).cancelTransfer(id);
        assert.ok(await findEvent(tx, dva, "TransferCancelled"));
        assert.equal(await status(id), CANCELLED);
        assert.equal(await bal(token, aurora), before);
        await expectRevert(async () => dva.connect(aurora).cancelTransfer(id), "TransferIsNotInPendingStatus");
        await expectRevert(async () => dva.connect(northbridge).approveTransfer(id, G), "TransferIsNotInPendingStatus");
      });

      it("only the sender can cancel; unknown ID reverts", async () => {
        const id = await initTransfer();
        await expectRevert(async () => dva.connect(northbridge).cancelTransfer(id), "OnlyTransferSenderCanCall");
        await expectRevert(async () => dva.connect(bndSafe).cancelTransfer(id), "OnlyTransferSenderCanCall");
        await expectRevert(async () => dva.connect(aurora).cancelTransfer(ethers.ZeroHash), "InvalidTransferID");
        await (await dva.connect(aurora).cancelTransfer(id)).wait();
      });
    });

    describe("rejectTransfer", () => {
      it("recipient rejects: status REJECTED and tokens returned", async () => {
        await setCrit(true, true, false, []);
        const before = await bal(token, aurora);
        const id = await initTransfer();
        const tx = await dva.connect(northbridge).rejectTransfer(id, G);
        const ev = await findEvent(tx, dva, "TransferRejected");
        assert.equal(ev.args.rejectedBy, northbridge.address);
        assert.equal(await status(id), REJECTED);
        assert.equal(await bal(token, aurora), before);
        await expectRevert(async () => dva.connect(northbridge).rejectTransfer(id, G), "TransferIsNotInPendingStatus");
      });

      it("agent can reject; already-approved approvers are skipped", async () => {
        const id = await initTransfer();
        await (await dva.connect(northbridge).approveTransfer(id, G)).wait();
        // recipient already approved, so only the agent slot remains and the agent may reject
        await (await dva.connect(bndSafe).rejectTransfer(id, G)).wait();
        assert.equal(await status(id), REJECTED);
      });

      it("non-approvers cannot reject (non-sequential -> ApproverNotFound)", async () => {
        const id = await initTransfer();
        await expectRevert(async () => dva.connect(outsider).rejectTransfer(id, G), "ApproverNotFound");
        // sender is not an approver
        await expectRevert(async () => dva.connect(aurora).rejectTransfer(id, G), "ApproverNotFound");
        await (await dva.connect(aurora).cancelTransfer(id)).wait();
      });

      it("sequential: a later approver cannot reject out of turn", async () => {
        await setCrit(true, true, true, []);
        const id = await initTransfer();
        await expectRevert(async () => dva.connect(bndSafe).rejectTransfer(id, G), "ApprovalsMustBeSequential");
        await (await dva.connect(northbridge).rejectTransfer(id, G)).wait();
        assert.equal(await status(id), REJECTED);
      });

      it("transfer with no approvers: reject reverts ApproverNotFound", async () => {
        await setCrit(false, false, false, []);
        const id = await initTransfer();
        await expectRevert(async () => dva.connect(northbridge).rejectTransfer(id, G), "ApproverNotFound");
        await (await dva.connect(aurora).cancelTransfer(id)).wait();
      });

      it("criteria change resets state instead of rejecting", async () => {
        await setCrit(true, false, false, []);
        const id = await initTransfer();
        await setCrit(true, true, false, []);
        const tx = await dva.connect(northbridge).rejectTransfer(id, G);
        assert.ok(await findEvent(tx, dva, "TransferApprovalStateReset"));
        assert.equal(await status(id), PENDING);
        await (await dva.connect(aurora).cancelTransfer(id)).wait();
      });

      it("unknown ID reverts", async () => {
        await expectRevert(async () => dva.connect(northbridge).rejectTransfer(ethers.ZeroHash), "InvalidTransferID");
      });
    });

    describe("fuzz: escrow accounting", () => {
      it("random initiate/cancel/complete sequences conserve the token supply", async () => {
        await setCrit(true, false, false, []);
        const rnd = prng(777);
        const supply = await token.totalSupply();
        const escrow0 = await bal(token, dvaAddr);
        for (let i = 0; i < 10; i++) {
          const amt = BigInt(Math.floor(rnd() * 20) + 1);
          const sBefore = await bal(token, aurora);
          const rBefore = await bal(token, northbridge);
          const id = await initTransfer(northbridge, amt);
          assert.equal(await bal(token, aurora), sBefore - amt);
          const choice = Math.floor(rnd() * 3);
          if (choice === 0) {
            await (await dva.connect(aurora).cancelTransfer(id)).wait();
            assert.equal(await bal(token, aurora), sBefore);
          } else if (choice === 1) {
            await (await dva.connect(northbridge).rejectTransfer(id, G)).wait();
            assert.equal(await bal(token, aurora), sBefore);
          } else {
            await (await dva.connect(northbridge).approveTransfer(id, G)).wait();
            assert.equal(await bal(token, northbridge), rBefore + amt);
          }
          assert.equal(await bal(token, dvaAddr), escrow0);
        }
        assert.equal(await token.totalSupply(), supply);
      });
    });
  });
});
