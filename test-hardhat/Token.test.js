import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { artifacts } from "hardhat";
import { readFileSync } from "node:fs";
import {
  setupProvider,
  getSigners,
  deployPlatform,
  deployContract,
  getContractAt,
  randomAddress,
  SUPPLY_LIMIT,
} from "./helpers.js";

const OWNER_ERR = "Ownable: caller is not the owner";
const AGENT_ERR = "AgentRole: caller does not have the Agent role";
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

/** All events with `name` emitted by `contract` in the tx. */
async function eventsOf(tx, contract, name) {
  const receipt = await tx.wait();
  const addr = (await contract.getAddress()).toLowerCase();
  const out = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== addr) continue;
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === name) out.push(parsed);
    } catch {
      /* not this event */
    }
  }
  return out;
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

const send = async (txp) => (await txp).wait();

const artifactCache = new Map();
async function cachedArtifact(name) {
  if (!artifactCache.has(name)) {
    let last;
    for (let i = 0; i < 20; i++) {
      try {
        artifactCache.set(name, await artifacts.readArtifact(name));
        return artifactCache.get(name);
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw last;
  }
  return artifactCache.get(name);
}
async function deployMock(signer, name, ...args) {
  const a = await cachedArtifact(name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}
/** Real ONCHAINID Identity, loaded from the npm package's prebuilt artifact. */
async function deployIdentity(signer, managementKey) {
  const a = JSON.parse(
    readFileSync("node_modules/@onchain-id/solidity/artifacts/contracts/Identity.sol/Identity.json", "utf8")
  );
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(managementKey, false);
  await c.waitForDeployment();
  return c;
}

let dealCounter = 0;
/** Like helpers.deployDeal, but with a unique name so the factory salt never collides. */
async function deployDealUnique(platform, platformAdmin, registrar, bndSafe) {
  dealCounter++;
  const sl = platform.supplyLimitModule;
  const tokenDetails = {
    owner: platformAdmin.address,
    name: `Token Test Bond ${dealCounter}`,
    symbol: `TTB-${dealCounter}`,
    decimals: 0,
    irs: ZERO,
    ONCHAINID: ZERO,
    irAgents: [registrar.address],
    tokenAgents: [bndSafe.address],
    complianceModules: [await sl.getAddress()],
    complianceSettings: [sl.interface.encodeFunctionData("setSupplyLimit", [SUPPLY_LIMIT])],
  };
  const receipt = await send(
    platform.gateway.deployTREXSuite(tokenDetails, { claimTopics: [], issuers: [], issuerClaims: [] })
  );
  const iface = new ethers.Interface((await artifacts.readArtifact("TREXFactory")).abi);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "TREXSuiteDeployed") {
        return { token: parsed.args[0], ir: parsed.args[1], irs: parsed.args[2], tir: parsed.args[3], ctr: parsed.args[4], mc: parsed.args[5] };
      }
    } catch {
      /* not this event */
    }
  }
  throw new Error("TREXSuiteDeployed event not found");
}

describe("Token", () => {
  let provider;
  let deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, meridian, outsider;
  let platform;

  before(async () => {
    ({ provider } = await setupProvider());
    ({ deployer, platformAdmin, registrar, bndSafe, aurora, northbridge, meridian, outsider } =
      await getSigners(provider));
    platform = await deployPlatform(deployer);
  });

  // ── fixtures ────────────────────────────────────────────────────────

  /** Fresh deal; aurora/northbridge/meridian registered in the IR; token unpaused. */
  async function freshDeal() {
    const deal = await deployDealUnique(platform, platformAdmin, registrar, bndSafe);
    const token = await getContractAt("Token", deal.token, deployer);
    const ir = await getContractAt("IdentityRegistry", deal.ir, deployer);
    const mc = await getContractAt("ModularCompliance", deal.mc, deployer);
    for (const s of [aurora, northbridge, meridian]) {
      const id = await deployMock(deployer, "MockIdentityForIR");
      await send(ir.connect(registrar).registerIdentity(s.address, await id.getAddress(), 356));
    }
    if (await token.paused()) await send(token.connect(bndSafe).unpause());
    return { deal, token, ir, mc };
  }

  const agent = (t) => t.connect(bndSafe);
  const owner = (t) => t.connect(platformAdmin);

  async function mintTo(token, to, amt) {
    await send(agent(token).mint(to, amt));
  }

  async function addRestrictModule(mc) {
    const impl = await deployContract(deployer, "TransferRestrictModule");
    const proxy = await deployContract(deployer, "ModuleProxy", await impl.getAddress(), "0x");
    const mod = await getContractAt("TransferRestrictModule", await proxy.getAddress(), deployer);
    await send(mod.initialize());
    await send(mc.connect(platformAdmin).addModule(await mod.getAddress()));
    return mod;
  }

  async function freshMc() {
    const mc = await deployContract(deployer, "ModularCompliance");
    await send(mc.init());
    return mc;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  init (standalone token)
  // ═══════════════════════════════════════════════════════════════════

  describe("init", () => {
    it("sets metadata, registries; starts paused; emits events", async () => {
      const t = await deployContract(deployer, "Token");
      const mc = await freshMc();
      const ir = randomAddress();
      const oid = randomAddress();
      const tx = await t.init(ir, await mc.getAddress(), "Bond", "BND", 6, oid);
      const upd = await eventsOf(tx, t, "UpdatedTokenInformation");
      assert.equal(upd.length, 1);
      assert.equal(Number(upd[0].args[2]), 6);
      assert.equal(upd[0].args[4], oid);
      assert.equal((await eventsOf(tx, t, "IdentityRegistryAdded"))[0].args[0], ir);
      assert.equal((await eventsOf(tx, t, "ComplianceAdded")).length, 1);
      assert.equal(await t.name(), "Bond");
      assert.equal(await t.symbol(), "BND");
      assert.equal(Number(await t.decimals()), 6);
      assert.equal(await t.onchainID(), oid);
      assert.equal(await t.identityRegistry(), ir);
      assert.equal(await t.compliance(), await mc.getAddress());
      assert.equal(await t.paused(), true);
      assert.equal(await t.owner(), deployer.address);
      assert.equal(await t.totalSupply(), 0n);
      assert.equal(await mc.getTokenBound(), await t.getAddress());
      assert.ok((await t.version()).length > 0);
    });

    it("accepts decimals of 0 and 18 and a zero onchainID", async () => {
      for (const d of [0, 18]) {
        const t = await deployContract(deployer, "Token");
        await send(t.init(randomAddress(), await (await freshMc()).getAddress(), "N", "S", d, ZERO));
        assert.equal(Number(await t.decimals()), d);
        assert.equal(await t.onchainID(), ZERO);
      }
    });

    it("rejects decimals above 18", async () => {
      const t = await deployContract(deployer, "Token");
      const mc = await freshMc();
      await expectRevert(
        async () => t.init(randomAddress(), await mc.getAddress(), "N", "S", 19, ZERO),
        "decimals between 0 and 18"
      );
    });

    it("rejects zero identity registry", async () => {
      const t = await deployContract(deployer, "Token");
      const mc = await freshMc();
      await expectRevert(
        async () => t.init(ZERO, await mc.getAddress(), "N", "S", 0, ZERO),
        "invalid argument - zero address"
      );
    });

    it("rejects zero compliance", async () => {
      const t = await deployContract(deployer, "Token");
      await expectRevert(
        async () => t.init(randomAddress(), ZERO, "N", "S", 0, ZERO),
        "invalid argument - zero address"
      );
    });

    it("rejects an empty name", async () => {
      const t = await deployContract(deployer, "Token");
      const mc = await freshMc();
      await expectRevert(
        async () => t.init(randomAddress(), await mc.getAddress(), "", "S", 0, ZERO),
        "invalid argument - empty string"
      );
    });

    it("rejects an empty symbol", async () => {
      const t = await deployContract(deployer, "Token");
      const mc = await freshMc();
      await expectRevert(
        async () => t.init(randomAddress(), await mc.getAddress(), "N", "", 0, ZERO),
        "invalid argument - empty string"
      );
    });

    it("cannot be initialised twice", async () => {
      const t = await deployContract(deployer, "Token");
      const mc = await freshMc();
      await send(t.init(randomAddress(), await mc.getAddress(), "N", "S", 0, ZERO));
      await expectRevert(
        async () => t.init(randomAddress(), await mc.getAddress(), "N2", "S2", 0, ZERO),
        "already initialized"
      );
    });

    it("deal token: wired by the factory with the expected metadata and roles", async () => {
      const { deal, token, mc, ir } = await freshDeal();
      assert.match(await token.name(), /^Token Test Bond \d+$/);
      assert.match(await token.symbol(), /^TTB-\d+$/);
      assert.equal(Number(await token.decimals()), 0);
      assert.equal(await token.owner(), platformAdmin.address);
      assert.equal(await token.identityRegistry(), deal.ir);
      assert.equal(await token.compliance(), deal.mc);
      assert.equal(await mc.getTokenBound(), deal.token);
      assert.equal(await token.isAgent(bndSafe.address), true);
      assert.equal(await token.isAgent(registrar.address), false);
      assert.equal(await ir.isAgent(deal.token), true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  agent role
  // ═══════════════════════════════════════════════════════════════════

  describe("agent role", () => {
    it("owner can add and remove agents; events emitted", async () => {
      const { token } = await freshDeal();
      const a = randomAddress();
      const add = await owner(token).addAgent(a);
      assert.equal((await eventsOf(add, token, "AgentAdded"))[0].args[0], a);
      assert.equal(await token.isAgent(a), true);
      const rem = await owner(token).removeAgent(a);
      assert.equal((await eventsOf(rem, token, "AgentRemoved"))[0].args[0], a);
      assert.equal(await token.isAgent(a), false);
    });

    it("non-owner cannot add or remove agents", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => token.connect(outsider).addAgent(randomAddress()), OWNER_ERR);
      await expectRevert(() => agent(token).addAgent(randomAddress()), OWNER_ERR);
      await expectRevert(() => token.connect(outsider).removeAgent(bndSafe.address), OWNER_ERR);
    });

    it("rejects zero address for add and remove", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => owner(token).addAgent(ZERO), "invalid argument - zero address");
      await expectRevert(() => owner(token).removeAgent(ZERO), "invalid argument - zero address");
    });

    it("an added agent can act; a removed agent loses access", async () => {
      const { token } = await freshDeal();
      await send(owner(token).addAgent(outsider.address));
      await send(token.connect(outsider).setAddressFrozen(randomAddress(), true));
      await send(owner(token).removeAgent(outsider.address));
      await expectRevert(() => token.connect(outsider).setAddressFrozen(randomAddress(), true), AGENT_ERR);
    });

    it("adding an existing agent / removing a non-agent reverts (Roles library)", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => owner(token).addAgent(bndSafe.address));
      await expectRevert(() => owner(token).removeAgent(randomAddress()));
    });

    it("the AgentRole (non-upgradeable) base contract behaves the same", async () => {
      const ar = await deployContract(deployer, "AgentRole");
      const a = randomAddress();
      assert.equal(await ar.isAgent(a), false);
      const add = await ar.addAgent(a);
      assert.equal((await eventsOf(add, ar, "AgentAdded"))[0].args[0], a);
      assert.equal(await ar.isAgent(a), true);
      await expectRevert(() => ar.addAgent(ZERO), "invalid argument - zero address");
      await expectRevert(() => ar.removeAgent(ZERO), "invalid argument - zero address");
      await expectRevert(() => ar.addAgent(a));
      const rem = await ar.removeAgent(a);
      assert.equal((await eventsOf(rem, ar, "AgentRemoved"))[0].args[0], a);
      assert.equal(await ar.isAgent(a), false);
      await expectRevert(() => ar.connect(outsider).addAgent(a), OWNER_ERR);
      await expectRevert(() => ar.connect(outsider).removeAgent(a), OWNER_ERR);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  owner setters
  // ═══════════════════════════════════════════════════════════════════

  describe("owner setters", () => {
    it("setName updates the name and emits UpdatedTokenInformation", async () => {
      const { token } = await freshDeal();
      const tx = await owner(token).setName("New Name");
      assert.equal((await eventsOf(tx, token, "UpdatedTokenInformation")).length, 1);
      assert.equal(await token.name(), "New Name");
    });

    it("setName rejects empty string and non-owner", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => owner(token).setName(""), "invalid argument - empty string");
      await expectRevert(() => agent(token).setName("X"), OWNER_ERR);
    });

    it("setSymbol updates the symbol and emits UpdatedTokenInformation", async () => {
      const { token } = await freshDeal();
      const tx = await owner(token).setSymbol("NEW");
      assert.equal((await eventsOf(tx, token, "UpdatedTokenInformation")).length, 1);
      assert.equal(await token.symbol(), "NEW");
    });

    it("setSymbol rejects empty string and non-owner", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => owner(token).setSymbol(""), "invalid argument - empty string");
      await expectRevert(() => agent(token).setSymbol("X"), OWNER_ERR);
    });

    it("setOnchainID sets and clears the onchain ID", async () => {
      const { token } = await freshDeal();
      const oid = randomAddress();
      const tx = await owner(token).setOnchainID(oid);
      assert.equal((await eventsOf(tx, token, "UpdatedTokenInformation"))[0].args[4], oid);
      assert.equal(await token.onchainID(), oid);
      await send(owner(token).setOnchainID(ZERO));
      assert.equal(await token.onchainID(), ZERO);
    });

    it("setOnchainID is owner only", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => agent(token).setOnchainID(randomAddress()), OWNER_ERR);
    });

    it("setIdentityRegistry swaps the registry and emits event", async () => {
      const { token } = await freshDeal();
      const a = randomAddress();
      const tx = await owner(token).setIdentityRegistry(a);
      assert.equal((await eventsOf(tx, token, "IdentityRegistryAdded"))[0].args[0], a);
      assert.equal(await token.identityRegistry(), a);
    });

    it("setIdentityRegistry is owner only", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => agent(token).setIdentityRegistry(randomAddress()), OWNER_ERR);
    });

    it("setCompliance unbinds the old compliance and binds the new one", async () => {
      const { token, mc } = await freshDeal();
      const mc2 = await freshMc();
      const tx = await owner(token).setCompliance(await mc2.getAddress());
      assert.equal((await eventsOf(tx, token, "ComplianceAdded"))[0].args[0], await mc2.getAddress());
      assert.equal(await token.compliance(), await mc2.getAddress());
      assert.equal(await mc2.getTokenBound(), await token.getAddress());
      assert.equal(await mc.getTokenBound(), ZERO);
    });

    it("setCompliance is owner only", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => agent(token).setCompliance(randomAddress()), OWNER_ERR);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  pause / unpause
  // ═══════════════════════════════════════════════════════════════════

  describe("pause / unpause", () => {
    it("agent can pause and unpause with events", async () => {
      const { token } = await freshDeal();
      const p = await agent(token).pause();
      assert.equal((await eventsOf(p, token, "Paused"))[0].args[0], bndSafe.address);
      assert.equal(await token.paused(), true);
      const u = await agent(token).unpause();
      assert.equal((await eventsOf(u, token, "Unpaused"))[0].args[0], bndSafe.address);
      assert.equal(await token.paused(), false);
    });

    it("pause when paused and unpause when unpaused revert", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => agent(token).unpause(), "Pausable: not paused");
      await send(agent(token).pause());
      await expectRevert(() => agent(token).pause(), "Pausable: paused");
    });

    it("only agents can pause/unpause (owner and outsider rejected)", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => token.connect(outsider).pause(), AGENT_ERR);
      await expectRevert(() => owner(token).pause(), AGENT_ERR);
      await send(agent(token).pause());
      await expectRevert(() => token.connect(outsider).unpause(), AGENT_ERR);
    });

    it("transfers and transferFrom revert while paused", async () => {
      const { token } = await freshDeal();
      await mintTo(token, aurora.address, 100n);
      await send(token.connect(aurora).approve(northbridge.address, 50n));
      await send(agent(token).pause());
      await expectRevert(() => token.connect(aurora).transfer(northbridge.address, 1n), "Pausable: paused");
      await expectRevert(
        () => token.connect(northbridge).transferFrom(aurora.address, meridian.address, 1n),
        "Pausable: paused"
      );
      await expectRevert(() => token.connect(aurora).batchTransfer([northbridge.address], [1n]), "Pausable: paused");
    });

    it("agent operations (mint, burn, forcedTransfer, freeze) still work while paused", async () => {
      const { token } = await freshDeal();
      await send(agent(token).pause());
      await mintTo(token, aurora.address, 100n);
      await send(agent(token).forcedTransfer(aurora.address, northbridge.address, 10n));
      await send(agent(token).freezePartialTokens(aurora.address, 5n));
      await send(agent(token).burn(aurora.address, 10n));
      assert.equal(await token.balanceOf(aurora.address), 80n);
      assert.equal(await token.balanceOf(northbridge.address), 10n);
    });

    it("transfers work again after unpause", async () => {
      const { token } = await freshDeal();
      await mintTo(token, aurora.address, 10n);
      await send(agent(token).pause());
      await send(agent(token).unpause());
      await send(token.connect(aurora).transfer(northbridge.address, 4n));
      assert.equal(await token.balanceOf(northbridge.address), 4n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  mint / burn
  // ═══════════════════════════════════════════════════════════════════

  describe("mint", () => {
    it("mints to a verified investor; updates supply/balance; emits Transfer", async () => {
      const { token } = await freshDeal();
      const tx = await agent(token).mint(aurora.address, 250n);
      const ev = (await eventsOf(tx, token, "Transfer"))[0];
      assert.equal(ev.args[0], ZERO);
      assert.equal(ev.args[1], aurora.address);
      assert.equal(ev.args[2], 250n);
      assert.equal(await token.balanceOf(aurora.address), 250n);
      assert.equal(await token.totalSupply(), 250n);
    });

    it("accumulates across multiple mints", async () => {
      const { token } = await freshDeal();
      await mintTo(token, aurora.address, 10n);
      await mintTo(token, aurora.address, 15n);
      assert.equal(await token.balanceOf(aurora.address), 25n);
    });

    it("can mint exactly up to the supply limit but not beyond (compliance)", async () => {
      const { token } = await freshDeal();
      await mintTo(token, aurora.address, SUPPLY_LIMIT);
      assert.equal(await token.totalSupply(), SUPPLY_LIMIT);
      await expectRevert(() => agent(token).mint(aurora.address, 1n), "Compliance not followed");
    });

    it("rejects a single mint exceeding the supply limit", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => agent(token).mint(aurora.address, SUPPLY_LIMIT + 1n), "Compliance not followed");
    });

    it("rejects minting to an unregistered address", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => agent(token).mint(outsider.address, 1n), "Identity is not verified.");
    });

    it("rejects minting to the zero address (not verified)", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => agent(token).mint(ZERO, 1n), "Identity is not verified.");
    });

    it("is agent only", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => token.connect(outsider).mint(aurora.address, 1n), AGENT_ERR);
      await expectRevert(() => owner(token).mint(aurora.address, 1n), AGENT_ERR);
      await expectRevert(() => token.connect(registrar).mint(aurora.address, 1n), AGENT_ERR);
    });

    it("mint of zero amount is rejected by compliance bookkeeping", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => agent(token).mint(aurora.address, 0n), "invalid argument - no value mint");
    });

    it("batchMint mints to several investors", async () => {
      const { token } = await freshDeal();
      await send(agent(token).batchMint([aurora.address, northbridge.address, meridian.address], [1n, 2n, 3n]));
      assert.equal(await token.balanceOf(aurora.address), 1n);
      assert.equal(await token.balanceOf(northbridge.address), 2n);
      assert.equal(await token.balanceOf(meridian.address), 3n);
      assert.equal(await token.totalSupply(), 6n);
    });

    it("batchMint with an empty list is a no-op", async () => {
      const { token } = await freshDeal();
      await send(agent(token).batchMint([], []));
      assert.equal(await token.totalSupply(), 0n);
    });

    it("batchMint reverts atomically if any recipient is unverified", async () => {
      const { token } = await freshDeal();
      await expectRevert(
        () => agent(token).batchMint([aurora.address, outsider.address], [1n, 1n]),
        "Identity is not verified."
      );
      assert.equal(await token.balanceOf(aurora.address), 0n);
    });

    it("batchMint reverts when amounts array is shorter than recipients", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => agent(token).batchMint([aurora.address, northbridge.address], [1n]));
    });

    it("batchMint is agent only", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => token.connect(outsider).batchMint([aurora.address], [1n]), AGENT_ERR);
    });
  });

  describe("burn", () => {
    it("burns free balance; updates supply; emits Transfer to zero", async () => {
      const { token } = await freshDeal();
      await mintTo(token, aurora.address, 100n);
      const tx = await agent(token).burn(aurora.address, 40n);
      const ev = (await eventsOf(tx, token, "Transfer"))[0];
      assert.equal(ev.args[1], ZERO);
      assert.equal(await token.balanceOf(aurora.address), 60n);
      assert.equal(await token.totalSupply(), 60n);
    });

    it("burning more than balance reverts", async () => {
      const { token } = await freshDeal();
      await mintTo(token, aurora.address, 10n);
      await expectRevert(() => agent(token).burn(aurora.address, 11n), "cannot burn more than balance");
    });

    it("burning into the frozen portion unfreezes just enough", async () => {
      const { token } = await freshDeal();
      await mintTo(token, aurora.address, 100n);
      await send(agent(token).freezePartialTokens(aurora.address, 60n));
      const tx = await agent(token).burn(aurora.address, 70n);
      const ev = (await eventsOf(tx, token, "TokensUnfrozen"))[0];
      assert.equal(ev.args[0], aurora.address);
      assert.equal(ev.args[1], 30n);
      assert.equal(await token.getFrozenTokens(aurora.address), 30n);
      assert.equal(await token.balanceOf(aurora.address), 30n);
    });

    it("burning exactly the free balance does not unfreeze", async () => {
      const { token } = await freshDeal();
      await mintTo(token, aurora.address, 100n);
      await send(agent(token).freezePartialTokens(aurora.address, 60n));
      const tx = await agent(token).burn(aurora.address, 40n);
      assert.equal((await eventsOf(tx, token, "TokensUnfrozen")).length, 0);
      assert.equal(await token.getFrozenTokens(aurora.address), 60n);
    });

    it("burn(0x0, 0) reverts with burn-from-zero-address", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => agent(token).burn(ZERO, 0n), "ERC20: burn from the zero address");
    });

    it("is agent only", async () => {
      const { token } = await freshDeal();
      await expectRevert(() => token.connect(outsider).burn(aurora.address, 0n), AGENT_ERR);
    });

    it("batchBurn burns across holders", async () => {
      const { token } = await freshDeal();
      await send(agent(token).batchMint([aurora.address, northbridge.address], [10n, 20n]));
      await send(agent(token).batchBurn([aurora.address, northbridge.address], [4n, 5n]));
      assert.equal(await token.balanceOf(aurora.address), 6n);
      assert.equal(await token.balanceOf(northbridge.address), 15n);
      assert.equal(await token.totalSupply(), 21n);
    });

    it("batchBurn reverts atomically on over-burn; agent only; mismatched lengths", async () => {
      const { token } = await freshDeal();
      await mintTo(token, aurora.address, 10n);
      await expectRevert(
        () => agent(token).batchBurn([aurora.address, northbridge.address], [1n, 1n]),
        "cannot burn more than balance"
      );
      assert.equal(await token.balanceOf(aurora.address), 10n);
      await expectRevert(() => token.connect(outsider).batchBurn([aurora.address], [1n]), AGENT_ERR);
      await expectRevert(() => agent(token).batchBurn([aurora.address, aurora.address], [1n]));
    });

    it("burn frees up supply so it can be minted again at the cap", async () => {
      const { token } = await freshDeal();
      await mintTo(token, aurora.address, SUPPLY_LIMIT);
      await send(agent(token).burn(aurora.address, 100n));
      await mintTo(token, northbridge.address, 100n);
      assert.equal(await token.totalSupply(), SUPPLY_LIMIT);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  transfer
  // ═══════════════════════════════════════════════════════════════════

  describe("transfer", () => {
    async function setup() {
      const f = await freshDeal();
      await mintTo(f.token, aurora.address, 1000n);
      return f;
    }

    it("moves tokens between verified investors and emits Transfer", async () => {
      const { token } = await setup();
      const tx = await token.connect(aurora).transfer(northbridge.address, 300n);
      const ev = (await eventsOf(tx, token, "Transfer"))[0];
      assert.equal(ev.args[0], aurora.address);
      assert.equal(ev.args[1], northbridge.address);
      assert.equal(ev.args[2], 300n);
      assert.equal(await token.balanceOf(aurora.address), 700n);
      assert.equal(await token.balanceOf(northbridge.address), 300n);
      assert.equal(await token.totalSupply(), 1000n);
    });

    it("transfers the entire free balance", async () => {
      const { token } = await setup();
      await send(token.connect(aurora).transfer(northbridge.address, 1000n));
      assert.equal(await token.balanceOf(aurora.address), 0n);
    });

    it("transfer of zero is rejected by compliance bookkeeping", async () => {
      const { token } = await setup();
      await expectRevert(
        () => token.connect(aurora).transfer(northbridge.address, 0n),
        "invalid argument - no value transfer"
      );
    });

    it("rejects amount exceeding balance", async () => {
      const { token } = await setup();
      await expectRevert(() => token.connect(aurora).transfer(northbridge.address, 1001n), "Insufficient Balance");
    });

    it("rejects amount exceeding unfrozen balance", async () => {
      const { token } = await setup();
      await send(agent(token).freezePartialTokens(aurora.address, 900n));
      await expectRevert(() => token.connect(aurora).transfer(northbridge.address, 101n), "Insufficient Balance");
      await send(token.connect(aurora).transfer(northbridge.address, 100n));
    });

    it("rejects transfer from a frozen wallet", async () => {
      const { token } = await setup();
      await send(agent(token).setAddressFrozen(aurora.address, true));
      await expectRevert(() => token.connect(aurora).transfer(northbridge.address, 1n), "wallet is frozen");
    });

    it("rejects transfer to a frozen wallet", async () => {
      const { token } = await setup();
      await send(agent(token).setAddressFrozen(northbridge.address, true));
      await expectRevert(() => token.connect(aurora).transfer(northbridge.address, 1n), "wallet is frozen");
    });

    it("rejects transfer to an unregistered (unverified) address", async () => {
      const { token } = await setup();
      await expectRevert(() => token.connect(aurora).transfer(outsider.address, 1n), "Transfer not possible");
    });

    it("rejects transfer to the zero address", async () => {
      const { token } = await setup();
      await expectRevert(() => token.connect(aurora).transfer(ZERO, 1n), "Transfer not possible");
    });

    it("rejects transfer when the recipient's identity was deleted from the registry", async () => {
      const { token, ir } = await setup();
      await send(ir.connect(registrar).deleteIdentity(northbridge.address));
      await expectRevert(() => token.connect(aurora).transfer(northbridge.address, 1n), "Transfer not possible");
    });

    it("rejects transfer when compliance denies it, allows once lifted", async () => {
      const { token, mc } = await setup();
      const mod = await addRestrictModule(mc);
      await expectRevert(() => token.connect(aurora).transfer(northbridge.address, 1n), "Transfer not possible");
      const data = mod.interface.encodeFunctionData("allowUser", [northbridge.address]);
      await send(mc.connect(platformAdmin).callModuleFunction(data, await mod.getAddress()));
      assert.equal(await mod.isUserAllowed(await mc.getAddress(), northbridge.address), true);
      // explicit gas limit: estimateGas mis-simulates the module proxy's nested call here
      await send(token.connect(aurora).transfer(northbridge.address, 1n, { gasLimit: 1_000_000 }));
      assert.equal(await token.balanceOf(northbridge.address), 1n);
    });

    it("self-transfer keeps the balance unchanged", async () => {
      const { token } = await setup();
      await send(token.connect(aurora).transfer(aurora.address, 10n));
      assert.equal(await token.balanceOf(aurora.address), 1000n);
    });

    it("batchTransfer sends to several recipients", async () => {
      const { token } = await setup();
      await send(token.connect(aurora).batchTransfer([northbridge.address, meridian.address], [10n, 20n]));
      assert.equal(await token.balanceOf(northbridge.address), 10n);
      assert.equal(await token.balanceOf(meridian.address), 20n);
      assert.equal(await token.balanceOf(aurora.address), 970n);
    });

    it("batchTransfer with empty arrays is a no-op", async () => {
      const { token } = await setup();
      await send(token.connect(aurora).batchTransfer([], []));
    });

    it("batchTransfer reverts atomically when one leg fails", async () => {
      const { token } = await setup();
      await expectRevert(
        () => token.connect(aurora).batchTransfer([northbridge.address, outsider.address], [10n, 10n]),
        "Transfer not possible"
      );
      assert.equal(await token.balanceOf(northbridge.address), 0n);
      await expectRevert(() => token.connect(aurora).batchTransfer([northbridge.address, meridian.address], [10n]));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  approve / allowance / transferFrom
  // ═══════════════════════════════════════════════════════════════════

  describe("approve / allowance / transferFrom", () => {
    async function setup() {
      const f = await freshDeal();
      await mintTo(f.token, aurora.address, 1000n);
      return f;
    }

    it("approve sets allowance and emits Approval", async () => {
      const { token } = await setup();
      const tx = await token.connect(aurora).approve(northbridge.address, 77n);
      const ev = (await eventsOf(tx, token, "Approval"))[0];
      assert.equal(ev.args[0], aurora.address);
      assert.equal(ev.args[1], northbridge.address);
      assert.equal(ev.args[2], 77n);
      assert.equal(await token.allowance(aurora.address, northbridge.address), 77n);
      assert.equal(await token.allowance(northbridge.address, aurora.address), 0n);
    });

    it("approve overwrites a previous allowance", async () => {
      const { token } = await setup();
      await send(token.connect(aurora).approve(northbridge.address, 77n));
      await send(token.connect(aurora).approve(northbridge.address, 5n));
      assert.equal(await token.allowance(aurora.address, northbridge.address), 5n);
    });

    it("approve to the zero address reverts", async () => {
      const { token } = await setup();
      await expectRevert(() => token.connect(aurora).approve(ZERO, 1n), "ERC20: approve to the zero address");
    });

    it("approve works while paused", async () => {
      const { token } = await setup();
      await send(agent(token).pause());
      await send(token.connect(aurora).approve(northbridge.address, 3n));
      assert.equal(await token.allowance(aurora.address, northbridge.address), 3n);
    });

    it("increaseAllowance / decreaseAllowance adjust the allowance", async () => {
      const { token } = await setup();
      await send(token.connect(aurora).increaseAllowance(northbridge.address, 10n));
      await send(token.connect(aurora).increaseAllowance(northbridge.address, 5n));
      assert.equal(await token.allowance(aurora.address, northbridge.address), 15n);
      await send(token.connect(aurora).decreaseAllowance(northbridge.address, 6n));
      assert.equal(await token.allowance(aurora.address, northbridge.address), 9n);
    });

    it("decreaseAllowance below zero reverts; zero spender reverts", async () => {
      const { token } = await setup();
      await expectRevert(() => token.connect(aurora).decreaseAllowance(northbridge.address, 1n));
      await expectRevert(
        () => token.connect(aurora).increaseAllowance(ZERO, 1n),
        "ERC20: approve to the zero address"
      );
      await expectRevert(
        () => token.connect(aurora).decreaseAllowance(ZERO, 0n),
        "ERC20: approve to the zero address"
      );
    });

    it("transferFrom spends allowance, moves tokens, emits Transfer", async () => {
      const { token } = await setup();
      await send(token.connect(aurora).approve(northbridge.address, 100n));
      const tx = await token.connect(northbridge).transferFrom(aurora.address, meridian.address, 60n);
      const ev = (await eventsOf(tx, token, "Transfer"))[0];
      assert.equal(ev.args[0], aurora.address);
      assert.equal(ev.args[1], meridian.address);
      assert.equal(await token.allowance(aurora.address, northbridge.address), 40n);
      assert.equal(await token.balanceOf(meridian.address), 60n);
      assert.equal(await token.balanceOf(aurora.address), 940n);
    });

    it("transferFrom without enough allowance reverts", async () => {
      const { token } = await setup();
      await send(token.connect(aurora).approve(northbridge.address, 10n));
      await expectRevert(() => token.connect(northbridge).transferFrom(aurora.address, meridian.address, 11n));
      await expectRevert(() => token.connect(meridian).transferFrom(aurora.address, meridian.address, 1n));
    });

    it("transferFrom beyond balance reverts with Insufficient Balance", async () => {
      const { token } = await setup();
      await send(token.connect(aurora).approve(northbridge.address, 5000n));
      await expectRevert(
        () => token.connect(northbridge).transferFrom(aurora.address, meridian.address, 1001n),
        "Insufficient Balance"
      );
    });

    it("transferFrom cannot touch frozen tokens", async () => {
      const { token } = await setup();
      await send(token.connect(aurora).approve(northbridge.address, 5000n));
      await send(agent(token).freezePartialTokens(aurora.address, 950n));
      await expectRevert(
        () => token.connect(northbridge).transferFrom(aurora.address, meridian.address, 51n),
        "Insufficient Balance"
      );
    });

    it("transferFrom with a frozen sender or recipient reverts", async () => {
      const { token } = await setup();
      await send(token.connect(aurora).approve(northbridge.address, 100n));
      await send(agent(token).setAddressFrozen(aurora.address, true));
      await expectRevert(
        () => token.connect(northbridge).transferFrom(aurora.address, meridian.address, 1n),
        "wallet is frozen"
      );
      await send(agent(token).setAddressFrozen(aurora.address, false));
      await send(agent(token).setAddressFrozen(meridian.address, true));
      await expectRevert(
        () => token.connect(northbridge).transferFrom(aurora.address, meridian.address, 1n),
        "wallet is frozen"
      );
    });

    it("transferFrom to an unverified or zero address reverts", async () => {
      const { token } = await setup();
      await send(token.connect(aurora).approve(northbridge.address, 100n));
      await expectRevert(
        () => token.connect(northbridge).transferFrom(aurora.address, outsider.address, 1n),
        "Transfer not possible"
      );
      await expectRevert(
        () => token.connect(northbridge).transferFrom(aurora.address, ZERO, 1n),
        "Transfer not possible"
      );
    });

    it("transferFrom is blocked when compliance denies", async () => {
      const { token, mc } = await setup();
      await addRestrictModule(mc);
      await send(token.connect(aurora).approve(northbridge.address, 100n));
      await expectRevert(
        () => token.connect(northbridge).transferFrom(aurora.address, meridian.address, 1n),
        "Transfer not possible"
      );
    });

    it("transferFrom from the zero address with amount 0 hits the approve-from-zero guard", async () => {
      const { token } = await setup();
      await expectRevert(
        () => token.connect(northbridge).transferFrom(ZERO, meridian.address, 0n),
        "ERC20: approve from the zero address"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  forcedTransfer
  // ═══════════════════════════════════════════════════════════════════

  describe("forcedTransfer", () => {
    async function setup() {
      const f = await freshDeal();
      await mintTo(f.token, aurora.address, 1000n);
      return f;
    }

    it("moves tokens without allowance and emits Transfer", async () => {
      const { token } = await setup();
      const tx = await agent(token).forcedTransfer(aurora.address, northbridge.address, 400n);
      assert.equal((await eventsOf(tx, token, "Transfer")).length, 1);
      assert.equal(await token.balanceOf(aurora.address), 600n);
      assert.equal(await token.balanceOf(northbridge.address), 400n);
    });

    it("ignores frozen wallets (both sides)", async () => {
      const { token } = await setup();
      await send(agent(token).setAddressFrozen(aurora.address, true));
      await send(agent(token).setAddressFrozen(northbridge.address, true));
      await send(agent(token).forcedTransfer(aurora.address, northbridge.address, 10n));
      assert.equal(await token.balanceOf(northbridge.address), 10n);
    });

    it("takes only free balance without unfreezing when amount fits", async () => {
      const { token } = await setup();
      await send(agent(token).freezePartialTokens(aurora.address, 500n));
      const tx = await agent(token).forcedTransfer(aurora.address, northbridge.address, 500n);
      assert.equal((await eventsOf(tx, token, "TokensUnfrozen")).length, 0);
      assert.equal(await token.getFrozenTokens(aurora.address), 500n);
    });

    it("unfreezes the necessary amount when dipping into frozen tokens", async () => {
      const { token } = await setup();
      await send(agent(token).freezePartialTokens(aurora.address, 500n));
      const tx = await agent(token).forcedTransfer(aurora.address, northbridge.address, 800n);
      const ev = (await eventsOf(tx, token, "TokensUnfrozen"))[0];
      assert.equal(ev.args[1], 300n);
      assert.equal(await token.getFrozenTokens(aurora.address), 200n);
      assert.equal(await token.balanceOf(aurora.address), 200n);
    });

    it("works while paused", async () => {
      const { token } = await setup();
      await send(agent(token).pause());
      await send(agent(token).forcedTransfer(aurora.address, northbridge.address, 1n));
    });

    it("reverts when sender balance is too low", async () => {
      const { token } = await setup();
      await expectRevert(
        () => agent(token).forcedTransfer(aurora.address, northbridge.address, 1001n),
        "sender balance too low"
      );
    });

    it("reverts when recipient is unverified or zero", async () => {
      const { token } = await setup();
      await expectRevert(
        () => agent(token).forcedTransfer(aurora.address, outsider.address, 1n),
        "Transfer not possible"
      );
      await expectRevert(() => agent(token).forcedTransfer(aurora.address, ZERO, 1n), "Transfer not possible");
    });

    it("reverts when sender is the zero address (amount 0)", async () => {
      const { token } = await setup();
      await expectRevert(
        () => agent(token).forcedTransfer(ZERO, northbridge.address, 0n),
        "ERC20: transfer from the zero address"
      );
    });

    it("is agent only", async () => {
      const { token } = await setup();
      await expectRevert(
        () => token.connect(outsider).forcedTransfer(aurora.address, northbridge.address, 1n),
        AGENT_ERR
      );
      await expectRevert(() => owner(token).forcedTransfer(aurora.address, northbridge.address, 1n), AGENT_ERR);
    });

    it("batchForcedTransfer moves several legs", async () => {
      const { token } = await setup();
      await send(
        agent(token).batchForcedTransfer(
          [aurora.address, aurora.address],
          [northbridge.address, meridian.address],
          [100n, 200n]
        )
      );
      assert.equal(await token.balanceOf(northbridge.address), 100n);
      assert.equal(await token.balanceOf(meridian.address), 200n);
    });

    it("batchForcedTransfer is atomic, agent only, and checks array lengths", async () => {
      const { token } = await setup();
      await expectRevert(
        () =>
          agent(token).batchForcedTransfer(
            [aurora.address, aurora.address],
            [northbridge.address, outsider.address],
            [1n, 1n]
          ),
        "Transfer not possible"
      );
      assert.equal(await token.balanceOf(northbridge.address), 0n);
      await expectRevert(
        () => token.connect(outsider).batchForcedTransfer([aurora.address], [northbridge.address], [1n]),
        AGENT_ERR
      );
      await expectRevert(() =>
        agent(token).batchForcedTransfer([aurora.address, aurora.address], [northbridge.address], [1n, 1n])
      );
      await send(agent(token).batchForcedTransfer([], [], []));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  freezing
  // ═══════════════════════════════════════════════════════════════════

  describe("setAddressFrozen / freezePartialTokens / unfreezePartialTokens", () => {
    async function setup() {
      const f = await freshDeal();
      await mintTo(f.token, aurora.address, 100n);
      return f;
    }

    it("setAddressFrozen freezes and unfreezes with AddressFrozen event", async () => {
      const { token } = await setup();
      const tx = await agent(token).setAddressFrozen(aurora.address, true);
      const ev = (await eventsOf(tx, token, "AddressFrozen"))[0];
      assert.equal(ev.args[0], aurora.address);
      assert.equal(ev.args[1], true);
      assert.equal(ev.args[2], bndSafe.address);
      assert.equal(await token.isFrozen(aurora.address), true);
      await send(agent(token).setAddressFrozen(aurora.address, false));
      assert.equal(await token.isFrozen(aurora.address), false);
    });

    it("setAddressFrozen is agent only", async () => {
      const { token } = await setup();
      await expectRevert(() => token.connect(outsider).setAddressFrozen(aurora.address, true), AGENT_ERR);
      await expectRevert(() => owner(token).setAddressFrozen(aurora.address, true), AGENT_ERR);
    });

    it("a frozen wallet can still receive mints and forced transfers, and be burned", async () => {
      const { token } = await setup();
      await send(agent(token).setAddressFrozen(northbridge.address, true));
      await mintTo(token, northbridge.address, 5n);
      await send(agent(token).forcedTransfer(aurora.address, northbridge.address, 5n));
      await send(agent(token).burn(northbridge.address, 10n));
      assert.equal(await token.balanceOf(northbridge.address), 0n);
    });

    it("batchSetAddressFrozen sets multiple flags", async () => {
      const { token } = await setup();
      await send(
        agent(token).batchSetAddressFrozen([aurora.address, northbridge.address, meridian.address], [true, true, false])
      );
      assert.equal(await token.isFrozen(aurora.address), true);
      assert.equal(await token.isFrozen(northbridge.address), true);
      assert.equal(await token.isFrozen(meridian.address), false);
    });

    it("batchSetAddressFrozen: agent only, length mismatch reverts, empty ok", async () => {
      const { token } = await setup();
      await expectRevert(() => token.connect(outsider).batchSetAddressFrozen([aurora.address], [true]), AGENT_ERR);
      await expectRevert(() => agent(token).batchSetAddressFrozen([aurora.address, meridian.address], [true]));
      await send(agent(token).batchSetAddressFrozen([], []));
    });

    it("freezePartialTokens freezes, accumulates, and emits TokensFrozen", async () => {
      const { token } = await setup();
      const tx = await agent(token).freezePartialTokens(aurora.address, 30n);
      const ev = (await eventsOf(tx, token, "TokensFrozen"))[0];
      assert.equal(ev.args[0], aurora.address);
      assert.equal(ev.args[1], 30n);
      await send(agent(token).freezePartialTokens(aurora.address, 70n));
      assert.equal(await token.getFrozenTokens(aurora.address), 100n);
    });

    it("freezePartialTokens rejects amounts above balance", async () => {
      const { token } = await setup();
      await expectRevert(
        () => agent(token).freezePartialTokens(aurora.address, 101n),
        "Amount exceeds available balance"
      );
      await send(agent(token).freezePartialTokens(aurora.address, 60n));
      await expectRevert(
        () => agent(token).freezePartialTokens(aurora.address, 41n),
        "Amount exceeds available balance"
      );
    });

    it("freezePartialTokens is agent only", async () => {
      const { token } = await setup();
      await expectRevert(() => token.connect(outsider).freezePartialTokens(aurora.address, 1n), AGENT_ERR);
    });

    it("unfreezePartialTokens releases tokens and emits TokensUnfrozen", async () => {
      const { token } = await setup();
      await send(agent(token).freezePartialTokens(aurora.address, 50n));
      const tx = await agent(token).unfreezePartialTokens(aurora.address, 20n);
      const ev = (await eventsOf(tx, token, "TokensUnfrozen"))[0];
      assert.equal(ev.args[1], 20n);
      assert.equal(await token.getFrozenTokens(aurora.address), 30n);
      await send(token.connect(aurora).transfer(northbridge.address, 70n));
    });

    it("unfreezePartialTokens rejects more than frozen; agent only", async () => {
      const { token } = await setup();
      await send(agent(token).freezePartialTokens(aurora.address, 10n));
      await expectRevert(
        () => agent(token).unfreezePartialTokens(aurora.address, 11n),
        "Amount should be less than or equal to frozen tokens"
      );
      await expectRevert(() => token.connect(outsider).unfreezePartialTokens(aurora.address, 1n), AGENT_ERR);
    });

    it("batchFreezePartialTokens / batchUnfreezePartialTokens", async () => {
      const { token } = await setup();
      await mintTo(token, northbridge.address, 100n);
      await send(agent(token).batchFreezePartialTokens([aurora.address, northbridge.address], [10n, 20n]));
      assert.equal(await token.getFrozenTokens(aurora.address), 10n);
      assert.equal(await token.getFrozenTokens(northbridge.address), 20n);
      await send(agent(token).batchUnfreezePartialTokens([aurora.address, northbridge.address], [10n, 5n]));
      assert.equal(await token.getFrozenTokens(aurora.address), 0n);
      assert.equal(await token.getFrozenTokens(northbridge.address), 15n);
    });

    it("batch freeze/unfreeze: agent only, atomic, length mismatch, empty", async () => {
      const { token } = await setup();
      await expectRevert(() => token.connect(outsider).batchFreezePartialTokens([aurora.address], [1n]), AGENT_ERR);
      await expectRevert(() => token.connect(outsider).batchUnfreezePartialTokens([aurora.address], [1n]), AGENT_ERR);
      await expectRevert(
        () => agent(token).batchFreezePartialTokens([aurora.address, northbridge.address], [1n, 1n]),
        "Amount exceeds available balance"
      );
      assert.equal(await token.getFrozenTokens(aurora.address), 0n);
      await expectRevert(() => agent(token).batchFreezePartialTokens([aurora.address, aurora.address], [1n]));
      await expectRevert(() => agent(token).batchUnfreezePartialTokens([aurora.address, aurora.address], [0n]));
      await send(agent(token).batchFreezePartialTokens([], []));
      await send(agent(token).batchUnfreezePartialTokens([], []));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  recoveryAddress
  // ═══════════════════════════════════════════════════════════════════

  describe("recoveryAddress", () => {
    async function setup(opts = {}) {
      const f = await freshDeal();
      await mintTo(f.token, aurora.address, 1000n);
      const newWallet = randomAddress();
      // Real ONCHAINID whose management key is the new wallet => keyHasPurpose(.., 1) is true
      const investorId = await deployIdentity(deployer, opts.badKey ? randomAddress() : newWallet);
      return { ...f, newWallet, idAddr: await investorId.getAddress() };
    }

    it("moves the full balance, registers the new wallet, deletes the lost one", async () => {
      const { token, ir, newWallet, idAddr } = await setup();
      const tx = await agent(token).recoveryAddress(aurora.address, newWallet, idAddr);
      const ev = (await eventsOf(tx, token, "RecoverySuccess"))[0];
      assert.equal(ev.args[0], aurora.address);
      assert.equal(ev.args[1], newWallet);
      assert.equal(ev.args[2], idAddr);
      assert.equal(await token.balanceOf(aurora.address), 0n);
      assert.equal(await token.balanceOf(newWallet), 1000n);
      assert.equal(await ir.contains(newWallet), true);
      assert.equal(await ir.contains(aurora.address), false);
      assert.equal(await ir.investorCountry(newWallet), 356n);
      assert.equal(await token.totalSupply(), 1000n);
    });

    it("carries over partially frozen tokens", async () => {
      const { token, newWallet, idAddr } = await setup();
      await send(agent(token).freezePartialTokens(aurora.address, 400n));
      await send(agent(token).recoveryAddress(aurora.address, newWallet, idAddr));
      assert.equal(await token.getFrozenTokens(newWallet), 400n);
      assert.equal(await token.getFrozenTokens(aurora.address), 0n);
      assert.equal(await token.balanceOf(newWallet), 1000n);
    });

    it("carries over the frozen-address flag", async () => {
      const { token, newWallet, idAddr } = await setup();
      await send(agent(token).setAddressFrozen(aurora.address, true));
      await send(agent(token).recoveryAddress(aurora.address, newWallet, idAddr));
      assert.equal(await token.isFrozen(newWallet), true);
    });

    it("carries over both frozen tokens and frozen flag", async () => {
      const { token, newWallet, idAddr } = await setup();
      await send(agent(token).freezePartialTokens(aurora.address, 1000n));
      await send(agent(token).setAddressFrozen(aurora.address, true));
      await send(agent(token).recoveryAddress(aurora.address, newWallet, idAddr));
      assert.equal(await token.getFrozenTokens(newWallet), 1000n);
      assert.equal(await token.isFrozen(newWallet), true);
    });

    it("reverts when the lost wallet holds no tokens", async () => {
      const { token, newWallet, idAddr } = await setup();
      await expectRevert(
        () => agent(token).recoveryAddress(northbridge.address, newWallet, idAddr),
        "no tokens to recover"
      );
    });

    it("reverts when the ONCHAINID does not hold the new wallet's key", async () => {
      const { token, newWallet, idAddr } = await setup({ badKey: true });
      await expectRevert(
        () => agent(token).recoveryAddress(aurora.address, newWallet, idAddr),
        "Recovery not possible"
      );
    });

    it("is agent only", async () => {
      const { token, newWallet, idAddr } = await setup();
      await expectRevert(() => token.connect(outsider).recoveryAddress(aurora.address, newWallet, idAddr), AGENT_ERR);
      await expectRevert(() => owner(token).recoveryAddress(aurora.address, newWallet, idAddr), AGENT_ERR);
    });

    it("fails if the new wallet is already registered in the identity registry", async () => {
      const { token, idAddr } = await setup();
      await expectRevert(() => agent(token).recoveryAddress(aurora.address, northbridge.address, idAddr));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  views / ownership
  // ═══════════════════════════════════════════════════════════════════

  describe("views and ownership", () => {
    it("balanceOf / allowance / getFrozenTokens / isFrozen default to zero/false", async () => {
      const { token } = await freshDeal();
      const a = randomAddress();
      assert.equal(await token.balanceOf(a), 0n);
      assert.equal(await token.allowance(a, aurora.address), 0n);
      assert.equal(await token.getFrozenTokens(a), 0n);
      assert.equal(await token.isFrozen(a), false);
      assert.equal(await token.totalSupply(), 0n);
    });

    it("renounced ownership leaves setters unusable", async () => {
      const { token } = await freshDeal();
      await send(owner(token).renounceOwnership());
      assert.equal(await token.owner(), ZERO);
      await expectRevert(() => owner(token).setName("X"), OWNER_ERR);
    });

    it("transferOwnership hands setters to the new owner", async () => {
      const { token } = await freshDeal();
      await send(owner(token).transferOwnership(outsider.address));
      await send(token.connect(outsider).setName("Handed over"));
      assert.equal(await token.name(), "Handed over");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  fuzz
  // ═══════════════════════════════════════════════════════════════════

  describe("fuzz", () => {
    for (const seed of [1, 7, 42]) {
      it(`random mint/transfer/burn/freeze sequence keeps invariants (seed ${seed})`, async () => {
        const { token } = await freshDeal();
        const rnd = prng(seed);
        const holders = [aurora, northbridge, meridian];
        const model = new Map(holders.map((h) => [h.address, { bal: 0n, frozen: 0n }]));
        let supply = 0n;
        const pick = () => holders[Math.floor(rnd() * holders.length)];
        const amt = (max) => (max < 1n ? 0n : BigInt(1 + Math.floor(rnd() * Number(max > 50n ? 50n : max))));

        for (let i = 0; i < 40; i++) {
          const op = Math.floor(rnd() * 6);
          const a = pick();
          const b = pick();
          const ma = model.get(a.address);
          const mb = model.get(b.address);
          if (op === 0) {
            const x = amt(100n);
            await send(agent(token).mint(a.address, x));
            ma.bal += x;
            supply += x;
          } else if (op === 1) {
            const x = amt(ma.bal - ma.frozen);
            if (x > 0n && x <= ma.bal - ma.frozen && a.address !== b.address) {
              await send(token.connect(a).transfer(b.address, x));
              ma.bal -= x;
              mb.bal += x;
            }
          } else if (op === 2) {
            const x = amt(ma.bal);
            if (x > 0n && x <= ma.bal) {
              await send(agent(token).burn(a.address, x));
              const free = ma.bal - ma.frozen;
              if (x > free) ma.frozen -= x - free;
              ma.bal -= x;
              supply -= x;
            }
          } else if (op === 3) {
            const x = amt(ma.bal - ma.frozen);
            if (x > 0n && x <= ma.bal - ma.frozen) {
              await send(agent(token).freezePartialTokens(a.address, x));
              ma.frozen += x;
            }
          } else if (op === 4) {
            const x = amt(ma.frozen);
            if (x > 0n && x <= ma.frozen) {
              await send(agent(token).unfreezePartialTokens(a.address, x));
              ma.frozen -= x;
            }
          } else {
            const x = amt(ma.bal);
            if (x > 0n && x <= ma.bal && a.address !== b.address) {
              await send(agent(token).forcedTransfer(a.address, b.address, x));
              const free = ma.bal - ma.frozen;
              if (x > free) ma.frozen -= x - free;
              ma.bal -= x;
              mb.bal += x;
            }
          }
        }

        let sum = 0n;
        for (const h of holders) {
          const m = model.get(h.address);
          assert.equal(await token.balanceOf(h.address), m.bal, `balance of ${h.address}`);
          assert.equal(await token.getFrozenTokens(h.address), m.frozen, `frozen of ${h.address}`);
          assert.ok(m.frozen <= m.bal);
          sum += m.bal;
        }
        assert.equal(await token.totalSupply(), supply);
        assert.equal(sum, supply);
      });
    }

    it("random allowance / transferFrom sequence respects allowances (seed 99)", async () => {
      const { token } = await freshDeal();
      await mintTo(token, aurora.address, 1000n);
      const rnd = prng(99);
      let allowance = 0n;
      let bal = 1000n;
      for (let i = 0; i < 25; i++) {
        if (rnd() < 0.4) {
          allowance = BigInt(Math.floor(rnd() * 100));
          await send(token.connect(aurora).approve(northbridge.address, allowance));
        } else {
          const x = BigInt(Math.floor(rnd() * 100));
          const call = () => token.connect(northbridge).transferFrom(aurora.address, meridian.address, x);
          if (x <= allowance && x <= bal) {
            await send(call());
            allowance -= x;
            bal -= x;
          } else {
            await expectRevert(call);
          }
        }
        assert.equal(await token.allowance(aurora.address, northbridge.address), allowance);
        assert.equal(await token.balanceOf(aurora.address), bal);
      }
    });

    it("random transfers to registered/unregistered recipients (seed 5)", async () => {
      const { token } = await freshDeal();
      await mintTo(token, aurora.address, 500n);
      const rnd = prng(5);
      const targets = [northbridge.address, meridian.address, outsider.address, randomAddress()];
      let bal = 500n;
      for (let i = 0; i < 20; i++) {
        const t = targets[Math.floor(rnd() * targets.length)];
        const x = BigInt(1 + Math.floor(rnd() * 40));
        const verified = t === northbridge.address || t === meridian.address;
        const call = () => token.connect(aurora).transfer(t, x);
        if (verified) {
          await send(call());
          bal -= x;
        } else {
          await expectRevert(call, "Transfer not possible");
        }
        assert.equal(await token.balanceOf(aurora.address), bal);
      }
    });
  });
});
