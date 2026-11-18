import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { network, artifacts } from "hardhat";
import { ethers } from "ethers";
import {
  setupProvider,
  getSigners,
  deployPlatform,
  deployDeal,
  deployContract,
  getContractAt,
  findEvent,
  randomAddress,
  SUPPLY_LIMIT,
} from "./helpers.js";

describe("Phase 4: ModularCompliance", () => {
  let conn, provider;
  let deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, outsider;
  let platform, deal;
  let mc, slm, token, ir;

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

    mc = await getContractAt("ModularCompliance", deal.mc, platformAdmin);
    slm = platform.supplyLimitModule;
    token = await getContractAt("Token", deal.token, bndSafe);
    ir = await getContractAt("IdentityRegistry", deal.ir, registrar);
  });

  after(async () => {
    if (conn) await conn.close();
  });

  // ═══════════════════════════════════════════════════════════════════
  //  4.1 Token binding
  // ═══════════════════════════════════════════════════════════════════

  describe("4.1 Token binding", () => {
    it("token is bound to compliance", async () => {
      const bound = await mc.getTokenBound();
      assert.equal(bound.toLowerCase(), deal.token.toLowerCase());
    });

    it("getTokenBound returns non-zero address", async () => {
      const bound = await mc.getTokenBound();
      assert.notEqual(bound, ethers.ZeroAddress);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  4.2 Module binding — initial state
  // ═══════════════════════════════════════════════════════════════════

  describe("4.2 Module binding — initial state", () => {
    it("SupplyLimitModule is bound", async () => {
      const isBound = await mc.isModuleBound(await slm.getAddress());
      assert.equal(isBound, true);
    });

    it("getModules returns the module list with SupplyLimitModule", async () => {
      const modules = await mc.getModules();
      assert.ok(modules.length >= 1, "should have at least 1 module");
      const slmAddr = await slm.getAddress();
      const found = modules.some(
        (m) => m.toLowerCase() === slmAddr.toLowerCase()
      );
      assert.equal(found, true, "SupplyLimitModule not in modules list");
    });

    it("isModuleBound returns false for random address", async () => {
      assert.equal(await mc.isModuleBound(randomAddress()), false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  4.3 addModule / removeModule
  // ═══════════════════════════════════════════════════════════════════

  describe("4.3 addModule / removeModule", () => {
    let secondModule;

    before(async () => {
      const impl = await deployContract(deployer, "SupplyLimitModule");
      const proxy = await deployContract(
        deployer, "ModuleProxy", await impl.getAddress(), "0x"
      );
      secondModule = await getContractAt("SupplyLimitModule", await proxy.getAddress(), deployer);
      await (await secondModule.initialize()).wait();
    });

    it("owner can add a new module", async () => {
      const receipt = await (await mc.addModule(await secondModule.getAddress())).wait();
      const event = findEvent(receipt, mc, "ModuleAdded");
      assert.ok(event, "ModuleAdded event not found");
      assert.equal(await mc.isModuleBound(await secondModule.getAddress()), true);
    });

    it("non-owner cannot add module", async () => {
      const mcAsOutsider = mc.connect(outsider);
      const dummy = await deployContract(deployer, "SupplyLimitModule");
      const dummyProxy = await deployContract(
        deployer, "ModuleProxy", await dummy.getAddress(), "0x"
      );
      const dummyModule = await getContractAt("SupplyLimitModule", await dummyProxy.getAddress(), deployer);
      await (await dummyModule.initialize()).wait();
      await assert.rejects(
        async () => {
          await mcAsOutsider.addModule(await dummyModule.getAddress());
        },
        "non-owner should not add module"
      );
    });

    it("cannot add already bound module", async () => {
      await assert.rejects(
        async () => {
          await mc.addModule(await secondModule.getAddress());
        },
        "adding already bound module should revert"
      );
    });

    it("cannot add zero address module", async () => {
      await assert.rejects(
        async () => {
          await mc.addModule(ethers.ZeroAddress);
        },
        "zero address module should revert"
      );
    });

    it("owner can remove a module and emits event", async () => {
      const receipt = await (await mc.removeModule(await secondModule.getAddress())).wait();
      const event = findEvent(receipt, mc, "ModuleRemoved");
      assert.ok(event, "ModuleRemoved event not found");
      assert.equal(await mc.isModuleBound(await secondModule.getAddress()), false);
    });

    it("cannot remove unbound module", async () => {
      await assert.rejects(
        async () => {
          await mc.removeModule(randomAddress());
        },
        "removing unbound module should revert"
      );
    });

    it("non-owner cannot remove module", async () => {
      const mcAsOutsider = mc.connect(outsider);
      await assert.rejects(
        async () => {
          await mcAsOutsider.removeModule(await slm.getAddress());
        },
        "non-owner should not remove module"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  4.4 callModuleFunction
  // ═══════════════════════════════════════════════════════════════════

  describe("4.4 callModuleFunction", () => {
    it("owner can set supply limit via callModuleFunction", async () => {
      const iface = new ethers.Interface(["function setSupplyLimit(uint256)"]);
      const callData = iface.encodeFunctionData("setSupplyLimit", [9999n]);
      const receipt = await (await mc.callModuleFunction(callData, await slm.getAddress())).wait();
      const event = findEvent(receipt, mc, "ModuleInteraction");
      assert.ok(event, "ModuleInteraction event not found");

      const newLimit = await slm.getSupplyLimit(deal.mc);
      assert.equal(newLimit, 9999n);

      // restore original limit
      const restoreData = iface.encodeFunctionData("setSupplyLimit", [SUPPLY_LIMIT]);
      await (await mc.callModuleFunction(restoreData, await slm.getAddress())).wait();
    });

    it("non-owner cannot call module function", async () => {
      const mcAsOutsider = mc.connect(outsider);
      const iface = new ethers.Interface(["function setSupplyLimit(uint256)"]);
      const callData = iface.encodeFunctionData("setSupplyLimit", [1n]);
      await assert.rejects(
        async () => {
          await mcAsOutsider.callModuleFunction(callData, await slm.getAddress());
        },
        "non-owner should not call module function"
      );
    });

    it("cannot call function on unbound module", async () => {
      const iface = new ethers.Interface(["function setSupplyLimit(uint256)"]);
      const callData = iface.encodeFunctionData("setSupplyLimit", [1n]);
      await assert.rejects(
        async () => {
          await mc.callModuleFunction(callData, randomAddress());
        },
        "calling unbound module should revert"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  4.5 canTransfer (supply limit checks)
  // ═══════════════════════════════════════════════════════════════════

  describe("4.5 canTransfer", () => {
    it("allows mint within supply limit", async () => {
      const can = await mc.canTransfer(ethers.ZeroAddress, aurora.address, SUPPLY_LIMIT);
      assert.equal(can, true);
    });

    it("blocks mint exceeding supply limit", async () => {
      const can = await mc.canTransfer(ethers.ZeroAddress, aurora.address, SUPPLY_LIMIT + 1n);
      assert.equal(can, false);
    });

    it("allows regular transfer (non-mint)", async () => {
      const can = await mc.canTransfer(aurora.address, northbridge.address, 100n);
      assert.equal(can, true);
    });

    it("allows mint of 1 token", async () => {
      const can = await mc.canTransfer(ethers.ZeroAddress, aurora.address, 1n);
      assert.equal(can, true);
    });

    it("blocks mint of supply_limit + 1 when supply is 0", async () => {
      const can = await mc.canTransfer(ethers.ZeroAddress, aurora.address, SUPPLY_LIMIT + 1n);
      assert.equal(can, false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  4.6 SupplyLimitModule direct checks
  // ═══════════════════════════════════════════════════════════════════

  describe("4.6 SupplyLimitModule", () => {
    it("getSupplyLimit returns correct value", async () => {
      const limit = await slm.getSupplyLimit(deal.mc);
      assert.equal(limit, SUPPLY_LIMIT);
    });

    it("name returns SupplyLimitModule", async () => {
      assert.equal(await slm.name(), "SupplyLimitModule");
    });

    it("isPlugAndPlay returns true", async () => {
      assert.equal(await slm.isPlugAndPlay(), true);
    });

    it("canComplianceBind returns true", async () => {
      assert.equal(await slm.canComplianceBind(deal.mc), true);
    });

    it("canComplianceBind returns true for any address", async () => {
      assert.equal(await slm.canComplianceBind(randomAddress()), true);
    });

    it("non-compliance cannot call setSupplyLimit directly", async () => {
      await assert.rejects(
        async () => {
          await slm.setSupplyLimit(100n);
        },
        "direct setSupplyLimit should revert (only via compliance)"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  4.7 Access control — onlyToken
  // ═══════════════════════════════════════════════════════════════════

  describe("4.7 Access control — onlyToken", () => {
    it("non-token cannot call transferred", async () => {
      await assert.rejects(
        async () => {
          await mc.transferred(aurora.address, northbridge.address, 100n);
        },
        "non-token should not call transferred"
      );
    });

    it("non-token cannot call created", async () => {
      await assert.rejects(
        async () => {
          await mc.created(aurora.address, 100n);
        },
        "non-token should not call created"
      );
    });

    it("non-token cannot call destroyed", async () => {
      await assert.rejects(
        async () => {
          await mc.destroyed(aurora.address, 100n);
        },
        "non-token should not call destroyed"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  4.8 Integration — mint and check remaining capacity
  // ═══════════════════════════════════════════════════════════════════

  describe("4.8 Integration — mint affects canTransfer", () => {
    before(async () => {
      // whitelist bndSafe so it can receive minted tokens
      await (await ir.registerIdentity(bndSafe.address, bndSafe.address, 356)).wait();
      // unpause token
      await (await token.unpause()).wait();
    });

    it("after minting 3000, canTransfer allows 2000 more", async () => {
      await (await token.mint(bndSafe.address, 3000n)).wait();
      const can = await mc.canTransfer(ethers.ZeroAddress, bndSafe.address, 2000n);
      assert.equal(can, true);
    });

    it("after minting 3000, canTransfer blocks 2001 more", async () => {
      const can = await mc.canTransfer(ethers.ZeroAddress, bndSafe.address, 2001n);
      assert.equal(can, false);
    });

    it("after minting to exactly the limit, canTransfer blocks any mint", async () => {
      await (await token.mint(bndSafe.address, 2000n)).wait(); // total now 5000
      const can = await mc.canTransfer(ethers.ZeroAddress, bndSafe.address, 1n);
      assert.equal(can, false);
    });

    it("totalSupply matches supply limit after full mint", async () => {
      const supply = await token.totalSupply();
      assert.equal(supply, SUPPLY_LIMIT);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  4.9 Fuzz tests
  // ═══════════════════════════════════════════════════════════════════

  describe("4.9 Fuzz tests", () => {
    it("set random supply limits and verify via getSupplyLimit — 15 iterations", async () => {
      const iface = new ethers.Interface(["function setSupplyLimit(uint256)"]);
      for (let i = 0; i < 15; i++) {
        const limit = BigInt(Math.floor(Math.random() * 1_000_000)) + 1n;
        const callData = iface.encodeFunctionData("setSupplyLimit", [limit]);
        await (await mc.callModuleFunction(callData, await slm.getAddress())).wait();
        const stored = await slm.getSupplyLimit(deal.mc);
        assert.equal(stored, limit, `limit mismatch at iteration ${i}`);
      }
      // restore
      const restoreData = iface.encodeFunctionData("setSupplyLimit", [SUPPLY_LIMIT]);
      await (await mc.callModuleFunction(restoreData, await slm.getAddress())).wait();
    });

    it("canTransfer boundary: exactly at limit passes, limit+1 fails — 10 iterations", async () => {
      const iface = new ethers.Interface(["function setSupplyLimit(uint256)"]);
      for (let i = 0; i < 10; i++) {
        const limit = BigInt(Math.floor(Math.random() * 100_000)) + 5001n;
        const callData = iface.encodeFunctionData("setSupplyLimit", [limit]);
        await (await mc.callModuleFunction(callData, await slm.getAddress())).wait();

        // totalSupply is 5000 from earlier mints
        const remaining = limit - 5000n;
        if (remaining > 0n) {
          const canExact = await mc.canTransfer(ethers.ZeroAddress, bndSafe.address, remaining);
          assert.equal(canExact, true, `should allow exact remaining at limit ${limit}`);
        }
        const canOver = await mc.canTransfer(ethers.ZeroAddress, bndSafe.address, limit - 5000n + 1n);
        assert.equal(canOver, false, `should block over-limit at limit ${limit}`);
      }
      // restore
      const restoreData = iface.encodeFunctionData("setSupplyLimit", [SUPPLY_LIMIT]);
      await (await mc.callModuleFunction(restoreData, await slm.getAddress())).wait();
    });

    it("isModuleBound fuzz — 10 random addresses are not bound", async () => {
      for (let i = 0; i < 10; i++) {
        assert.equal(await mc.isModuleBound(randomAddress()), false);
      }
    });
  });
});
