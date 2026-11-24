import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  setupProvider,
  getSigners,
  deployPlatform,
  deployContract,
  getContractAt,
  randomAddress,
} from "./helpers.js";

// ethers caches identical RPC requests for 250ms (incl. failed estimateGas), which makes
// "expect revert, then succeed" sequences flaky, so disable the cache.
async function makeProvider() {
  const { conn } = await setupProvider();
  return new ethers.BrowserProvider(conn.provider, undefined, { cacheTimeout: -1 });
}

const ZERO = ethers.ZeroAddress;
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

const lc = (a) => a.toLowerCase();
const V100 = { major: 1, minor: 0, patch: 0 };
const V110 = { major: 1, minor: 1, patch: 0 };
const V120 = { major: 1, minor: 2, patch: 0 };

let nameCounter = 0;
const uniqueName = (p = "Bond") => `${p}-${Date.now()}-${nameCounter++}`;

function tokenDetails(owner, over = {}) {
  return {
    owner,
    name: uniqueName(),
    symbol: "TST",
    decimals: 0,
    irs: ZERO,
    ONCHAINID: ZERO,
    irAgents: [],
    tokenAgents: [],
    complianceModules: [],
    complianceSettings: [],
    ...over,
  };
}
const claimDetails = (over = {}) => ({ claimTopics: [], issuers: [], issuerClaims: [], ...over });

describe("TREXGateway", () => {
  let provider, conn;
  let deployer, platformAdmin, registrar, bndSafe, outsider, aurora, northbridge;
  let platform, gateway, cash;

  before(async () => {
    provider = await makeProvider();
    ({ deployer, platformAdmin, registrar, bndSafe, outsider, aurora, northbridge } = await getSigners(provider));
    platform = await deployPlatform(deployer);
    gateway = platform.gateway;
    cash = platform.cashToken;
  });

  const as = (signer) => gateway.connect(signer);

  describe("constructor / setters / views", () => {
    it("constructor stores factory and public status and emits events", async () => {
      const fresh = await deployContract(deployer, "TREXGateway", await platform.factory.getAddress(), true);
      assert.equal(lc(await fresh.getFactory()), lc(await platform.factory.getAddress()));
      assert.equal(await fresh.getPublicDeploymentStatus(), true);
      assert.equal(await fresh.isDeploymentFeeEnabled(), false);
      const fee = await fresh.getDeploymentFee();
      assert.equal(fee.fee, 0n);
      assert.equal(fee.feeToken, ZERO);
      assert.equal(fee.feeCollector, ZERO);
      const receipt = await fresh.deploymentTransaction().wait();
      const names = receipt.logs.map((l) => fresh.interface.parseLog(l)?.name);
      assert.ok(names.includes("FactorySet"));
      assert.ok(names.includes("PublicDeploymentStatusSet"));
    });

    it("setFactory: owner only, no zero address, emits FactorySet", async () => {
      const original = await gateway.getFactory();
      await expectRevert(async () => as(outsider).setFactory(randomAddress()), OWNER_ERR);
      await expectRevert(async () => gateway.setFactory(ZERO), "ZeroAddress");
      const other = randomAddress();
      const tx = await gateway.setFactory(other);
      const [ev] = await eventsOf(tx, gateway, "FactorySet");
      assert.equal(lc(ev.args[0]), lc(other));
      assert.equal(lc(await gateway.getFactory()), lc(other));
      await (await gateway.setFactory(original)).wait();
    });

    it("setPublicDeploymentStatus: toggles, rejects redundant values, owner only", async () => {
      await expectRevert(async () => as(outsider).setPublicDeploymentStatus(true), OWNER_ERR);
      await expectRevert(async () => gateway.setPublicDeploymentStatus(false), "PublicDeploymentAlreadyDisabled");
      const tx = await gateway.setPublicDeploymentStatus(true);
      const [ev] = await eventsOf(tx, gateway, "PublicDeploymentStatusSet");
      assert.equal(ev.args[0], true);
      assert.equal(await gateway.getPublicDeploymentStatus(), true);
      await expectRevert(async () => gateway.setPublicDeploymentStatus(true), "PublicDeploymentAlreadyEnabled");
      await (await gateway.setPublicDeploymentStatus(false)).wait();
      assert.equal(await gateway.getPublicDeploymentStatus(), false);
    });

    it("enableDeploymentFee: toggles, rejects redundant values, owner only", async () => {
      await expectRevert(async () => as(outsider).enableDeploymentFee(true), OWNER_ERR);
      await expectRevert(async () => gateway.enableDeploymentFee(false), "DeploymentFeesAlreadyDisabled");
      const tx = await gateway.enableDeploymentFee(true);
      const [ev] = await eventsOf(tx, gateway, "DeploymentFeeEnabled");
      assert.equal(ev.args[0], true);
      assert.equal(await gateway.isDeploymentFeeEnabled(), true);
      await expectRevert(async () => gateway.enableDeploymentFee(true), "DeploymentFeesAlreadyEnabled");
      await (await gateway.enableDeploymentFee(false)).wait();
      assert.equal(await gateway.isDeploymentFeeEnabled(), false);
    });

    it("setDeploymentFee: validates addresses, owner only, stores fee", async () => {
      const token = randomAddress();
      const collector = randomAddress();
      await expectRevert(async () => as(outsider).setDeploymentFee(1n, token, collector), OWNER_ERR);
      await expectRevert(async () => gateway.setDeploymentFee(1n, ZERO, collector), "ZeroAddress");
      await expectRevert(async () => gateway.setDeploymentFee(1n, token, ZERO), "ZeroAddress");
      const tx = await gateway.setDeploymentFee(77n, token, collector);
      const [ev] = await eventsOf(tx, gateway, "DeploymentFeeSet");
      assert.equal(ev.args[0], 77n);
      const fee = await gateway.getDeploymentFee();
      assert.equal(fee.fee, 77n);
      assert.equal(lc(fee.feeToken), lc(token));
      assert.equal(lc(fee.feeCollector), lc(collector));
    });

    it("transferFactoryOwnership: owner only, hands the factory to a new owner", async () => {
      const fresh = await deployPlatform(deployer);
      const g = fresh.gateway;
      await expectRevert(async () => g.connect(outsider).transferFactoryOwnership(outsider.address), OWNER_ERR);
      await (await g.transferFactoryOwnership(platformAdmin.address)).wait();
      assert.equal(lc(await fresh.factory.owner()), lc(platformAdmin.address));
    });
  });

  describe("deployer management", () => {
    it("addDeployer / removeDeployer by owner, with events and existence checks", async () => {
      const d = randomAddress();
      assert.equal(await gateway.isDeployer(d), false);
      await expectRevert(async () => gateway.removeDeployer(d), "DeployerDoesNotExist");
      const tx = await gateway.addDeployer(d);
      const [ev] = await eventsOf(tx, gateway, "DeployerAdded");
      assert.equal(lc(ev.args[0]), lc(d));
      assert.equal(await gateway.isDeployer(d), true);
      await expectRevert(async () => gateway.addDeployer(d), "DeployerAlreadyExists");
      const tx2 = await gateway.removeDeployer(d);
      const [ev2] = await eventsOf(tx2, gateway, "DeployerRemoved");
      assert.equal(lc(ev2.args[0]), lc(d));
      assert.equal(await gateway.isDeployer(d), false);
    });

    it("access control: only owner or agent may manage deployers and discounts", async () => {
      const d = randomAddress();
      await expectRevert(async () => as(outsider).addDeployer(d), "OnlyAdminCall");
      await expectRevert(async () => as(outsider).removeDeployer(d), "OnlyAdminCall");
      await expectRevert(async () => as(outsider).batchAddDeployer([d]), "OnlyAdminCall");
      await expectRevert(async () => as(outsider).batchRemoveDeployer([d]), "OnlyAdminCall");
      await expectRevert(async () => as(outsider).applyFeeDiscount(d, 1), "OnlyAdminCall");
      await expectRevert(async () => as(outsider).batchApplyFeeDiscount([d], [1]), "OnlyAdminCall");
    });

    it("an agent can manage deployers and discounts; owner can add agents only", async () => {
      await expectRevert(async () => as(outsider).addAgent(registrar.address), OWNER_ERR);
      await (await gateway.addAgent(registrar.address)).wait();
      assert.equal(await gateway.isAgent(registrar.address), true);
      const d = randomAddress();
      await (await as(registrar).addDeployer(d)).wait();
      assert.equal(await gateway.isDeployer(d), true);
      await (await as(registrar).applyFeeDiscount(d, 250)).wait();
      await (await as(registrar).removeDeployer(d)).wait();
      assert.equal(await gateway.isDeployer(d), false);
      await (await gateway.removeAgent(registrar.address)).wait();
      await expectRevert(async () => as(registrar).addDeployer(d), "OnlyAdminCall");
    });

    it("batchAddDeployer / batchRemoveDeployer happy path and failures", async () => {
      const list = [randomAddress(), randomAddress(), randomAddress()];
      const tx = await gateway.batchAddDeployer(list);
      assert.equal((await eventsOf(tx, gateway, "DeployerAdded")).length, 3);
      for (const a of list) assert.equal(await gateway.isDeployer(a), true);
      await expectRevert(async () => gateway.batchAddDeployer([randomAddress(), list[1]]), "DeployerAlreadyExists");
      // revert is atomic: the first address of the failed batch was not kept
      const tx2 = await gateway.batchRemoveDeployer(list);
      assert.equal((await eventsOf(tx2, gateway, "DeployerRemoved")).length, 3);
      for (const a of list) assert.equal(await gateway.isDeployer(a), false);
      await expectRevert(async () => gateway.batchRemoveDeployer([randomAddress()]), "DeployerDoesNotExist");
    });

    it("batch operations cap at 500 entries", async () => {
      const big = Array.from({ length: 501 }, () => randomAddress());
      await expectRevert(async () => gateway.batchAddDeployer(big), "BatchMaxLengthExceeded");
      await expectRevert(async () => gateway.batchRemoveDeployer(big), "BatchMaxLengthExceeded");
      await expectRevert(
        () => gateway.batchApplyFeeDiscount(big, big.map(() => 1)),
        "BatchMaxLengthExceeded"
      );
    });

    it("fuzz: add/remove random deployer sets keeps isDeployer consistent", async () => {
      const rand = prng(1234);
      const pool = Array.from({ length: 12 }, () => randomAddress());
      const model = new Set();
      for (let round = 0; round < 8; round++) {
        const pick = pool.filter(() => rand() < 0.4);
        if (pick.length === 0) continue;
        const adding = rand() < 0.5;
        const conflict = adding ? pick.some((a) => model.has(a)) : pick.some((a) => !model.has(a));
        const fn = adding ? "batchAddDeployer" : "batchRemoveDeployer";
        if (conflict) {
          await expectRevert(async () => gateway[fn](pick), adding ? "DeployerAlreadyExists" : "DeployerDoesNotExist");
        } else {
          await (await gateway[fn](pick)).wait();
          pick.forEach((a) => (adding ? model.add(a) : model.delete(a)));
        }
        for (const a of pool) assert.equal(await gateway.isDeployer(a), model.has(a));
      }
      // cleanup
      if (model.size) await (await gateway.batchRemoveDeployer([...model])).wait();
    });
  });

  describe("fee discounts and calculateFee", () => {
    it("applyFeeDiscount: range check, event, calculateFee reflects discount", async () => {
      const d = randomAddress();
      await (await gateway.setDeploymentFee(1000n, await cash.getAddress(), bndSafe.address)).wait();
      assert.equal(await gateway.calculateFee(d), 1000n);
      await expectRevert(async () => gateway.applyFeeDiscount(d, 10001), "DiscountOutOfRange");
      const tx = await gateway.applyFeeDiscount(d, 2500);
      const [ev] = await eventsOf(tx, gateway, "FeeDiscountApplied");
      assert.equal(ev.args[1], 2500n);
      assert.equal(await gateway.calculateFee(d), 750n);
      await (await gateway.applyFeeDiscount(d, 10000)).wait();
      assert.equal(await gateway.calculateFee(d), 0n);
    });

    it("batchApplyFeeDiscount: applies each, rejects out-of-range, atomic", async () => {
      const a = randomAddress();
      const b = randomAddress();
      await (await gateway.batchApplyFeeDiscount([a, b], [100, 5000])).wait();
      assert.equal(await gateway.calculateFee(a), 990n);
      assert.equal(await gateway.calculateFee(b), 500n);
      await expectRevert(async () => gateway.batchApplyFeeDiscount([a, b], [0, 10001]), "DiscountOutOfRange");
      assert.equal(await gateway.calculateFee(a), 990n, "failed batch must not partially apply");
    });

    it("fuzz: calculateFee == fee - fee*discount/10000", async () => {
      const rand = prng(99);
      for (let i = 0; i < 10; i++) {
        const fee = BigInt(Math.floor(rand() * 1e9));
        const disc = Math.floor(rand() * 10001);
        const d = randomAddress();
        await (await gateway.setDeploymentFee(fee, await cash.getAddress(), bndSafe.address)).wait();
        await (await gateway.applyFeeDiscount(d, disc)).wait();
        assert.equal(await gateway.calculateFee(d), fee - (BigInt(disc) * fee) / 10000n);
      }
    });
  });

  describe("deployTREXSuite / batchDeployTREXSuite", () => {
    it("private mode: non-deployer is rejected, deployer succeeds and token is salted by owner+name", async () => {
      const td = tokenDetails(platformAdmin.address);
      await expectRevert(async () => as(outsider).deployTREXSuite(td, claimDetails()), "PublicDeploymentsNotAllowed");
      const tx = await gateway.deployTREXSuite(td, claimDetails()); // deployer is a deployer
      const [ev] = await eventsOf(tx, gateway, "GatewaySuiteDeploymentProcessed");
      assert.equal(lc(ev.args[0]), lc(deployer.address));
      assert.equal(lc(ev.args[1]), lc(platformAdmin.address));
      assert.equal(ev.args[2], 0n);
      const salt = platformAdmin.address.toLowerCase() + td.name;
      const tokenAddr = await platform.factory.getToken(salt);
      assert.notEqual(tokenAddr, ZERO);
      assert.equal(lc(await platform.factory.tokenDeployed(salt)), lc(tokenAddr));
      const token = await getContractAt("Token", tokenAddr, deployer);
      assert.equal(lc(await token.owner()), lc(platformAdmin.address));
      // same owner+name again collides on the factory salt
      await expectRevert(async () => gateway.deployTREXSuite(td, claimDetails()), "token already deployed");
    });

    it("public mode: owner may deploy for self, deployers on behalf, others cannot", async () => {
      await (await gateway.setPublicDeploymentStatus(true)).wait();
      try {
        const own = tokenDetails(outsider.address);
        await (await as(outsider).deployTREXSuite(own, claimDetails())).wait();
        await expectRevert(
          () => as(outsider).deployTREXSuite(tokenDetails(aurora.address), claimDetails()),
          "PublicCannotDeployOnBehalf"
        );
        // registered deployer can deploy on behalf of anyone even when public
        await (await gateway.deployTREXSuite(tokenDetails(aurora.address), claimDetails())).wait();
      } finally {
        await (await gateway.setPublicDeploymentStatus(false)).wait();
      }
    });

    it("fee enabled: charges discounted fee, pays collector, emits fee in event", async () => {
      const fee = 1000n;
      const collector = northbridge.address;
      await (await gateway.setDeploymentFee(fee, await cash.getAddress(), collector)).wait();
      await (await gateway.enableDeploymentFee(true)).wait();
      try {
        await (await cash.mint(deployer.address, 10_000n)).wait();
        await (await cash.approve(await gateway.getAddress(), 10_000n)).wait();
        await (await gateway.applyFeeDiscount(deployer.address, 1000)).wait(); // 10%
        const before = await cash.balanceOf(collector);
        const tx = await gateway.deployTREXSuite(tokenDetails(platformAdmin.address), claimDetails());
        const [ev] = await eventsOf(tx, gateway, "GatewaySuiteDeploymentProcessed");
        assert.equal(ev.args[2], 900n);
        assert.equal((await cash.balanceOf(collector)) - before, 900n);

        // missing allowance => transferFrom reverts and the deployment is rolled back
        await (await cash.approve(await gateway.getAddress(), 0n)).wait();
        await expectRevert(async () => gateway.deployTREXSuite(tokenDetails(platformAdmin.address), claimDetails()));

        // 100% discount => no fee taken
        await (await gateway.applyFeeDiscount(deployer.address, 10000)).wait();
        const bal = await cash.balanceOf(collector);
        const tx2 = await gateway.deployTREXSuite(tokenDetails(platformAdmin.address), claimDetails());
        const [ev2] = await eventsOf(tx2, gateway, "GatewaySuiteDeploymentProcessed");
        assert.equal(ev2.args[2], 0n);
        assert.equal(await cash.balanceOf(collector), bal);

        // zero fee => no fee taken
        await (await gateway.applyFeeDiscount(deployer.address, 0)).wait();
        await (await gateway.setDeploymentFee(0n, await cash.getAddress(), collector)).wait();
        const tx3 = await gateway.deployTREXSuite(tokenDetails(platformAdmin.address), claimDetails());
        const [ev3] = await eventsOf(tx3, gateway, "GatewaySuiteDeploymentProcessed");
        assert.equal(ev3.args[2], 0n);
      } finally {
        await (await gateway.enableDeploymentFee(false)).wait();
      }
    });

    it("fee disabled: no fee is taken even when fee configured", async () => {
      await (await gateway.setDeploymentFee(500n, await cash.getAddress(), northbridge.address)).wait();
      const tx = await gateway.deployTREXSuite(tokenDetails(platformAdmin.address), claimDetails());
      const [ev] = await eventsOf(tx, gateway, "GatewaySuiteDeploymentProcessed");
      assert.equal(ev.args[2], 0n);
    });

    it("batchDeployTREXSuite deploys several suites, caps at 5, requires matching claim details", async () => {
      const tds = [tokenDetails(platformAdmin.address), tokenDetails(aurora.address)];
      const tx = await gateway.batchDeployTREXSuite(tds, [claimDetails(), claimDetails()]);
      assert.equal((await eventsOf(tx, gateway, "GatewaySuiteDeploymentProcessed")).length, 2);
      for (const td of tds) {
        assert.notEqual(await platform.factory.getToken(lc(td.owner) + td.name), ZERO);
      }
      const six = Array.from({ length: 6 }, () => tokenDetails(platformAdmin.address));
      await expectRevert(
        () => gateway.batchDeployTREXSuite(six, six.map(() => claimDetails())),
        "BatchMaxLengthExceeded"
      );
      await expectRevert(async () => gateway.batchDeployTREXSuite(tds, [claimDetails()])); // index out of bounds
      await expectRevert(
        () => as(outsider).batchDeployTREXSuite(tds, [claimDetails(), claimDetails()]),
        "PublicDeploymentsNotAllowed"
      );
    });
  });
});

describe("TREXFactory", () => {
  let provider;
  let deployer, platformAdmin, registrar, bndSafe, outsider, aurora;
  let platform, factory, slAddr;

  before(async () => {
    provider = await makeProvider();
    ({ deployer, platformAdmin, registrar, bndSafe, outsider, aurora } = await getSigners(provider));
    platform = await deployPlatform(deployer);
    // take direct ownership of the factory (gateway stays deployed but is bypassed)
    await (await platform.gateway.transferFactoryOwnership(deployer.address)).wait();
    factory = platform.factory;
    slAddr = await platform.supplyLimitModule.getAddress();
  });

  const salt = () => uniqueName("salt");
  const deploy = (td, cd = claimDetails(), s = salt()) => factory.deployTREXSuite(s, td, cd);

  it("constructor sets IA; getImplementationAuthority returns it", async () => {
    assert.equal(lc(await factory.getImplementationAuthority()), lc(await platform.ia.getAddress()));
    assert.equal(lc(await factory.owner()), lc(deployer.address));
  });

  it("deployTREXSuite wires agents, owners, claims, modules and records token by salt", async () => {
    const s = salt();
    const settings = platform.supplyLimitModule.interface.encodeFunctionData("setSupplyLimit", [1234n]);
    const issuer1 = randomAddress();
    const issuer2 = randomAddress();
    const td = tokenDetails(platformAdmin.address, {
      irAgents: [registrar.address],
      tokenAgents: [bndSafe.address],
      complianceModules: [slAddr],
      complianceSettings: [settings],
    });
    const cd = claimDetails({
      claimTopics: [1, 2],
      issuers: [issuer1, issuer2],
      issuerClaims: [[1], [1, 2]],
    });
    const tx = await factory.deployTREXSuite(s, td, cd);
    const [ev] = await eventsOf(tx, factory, "TREXSuiteDeployed");
    assert.equal(ev.args[6].hash, ethers.id(s));
    const token = await getContractAt("Token", ev.args[0], deployer);
    const ir = await getContractAt("IdentityRegistry", ev.args[1], deployer);
    const tir = await getContractAt("TrustedIssuersRegistry", ev.args[3], deployer);
    const ctr = await getContractAt("ClaimTopicsRegistry", ev.args[4], deployer);
    const mc = await getContractAt("ModularCompliance", ev.args[5], deployer);
    assert.equal(lc(await factory.getToken(s)), lc(ev.args[0]));
    for (const c of [token, ir, tir, ctr, mc]) assert.equal(lc(await c.owner()), lc(platformAdmin.address));
    assert.equal(await token.isAgent(bndSafe.address), true);
    assert.equal(await ir.isAgent(registrar.address), true);
    assert.equal(await ir.isAgent(ev.args[0]), true);
    assert.deepEqual((await ctr.getClaimTopics()).map(Number), [1, 2]);
    assert.equal((await tir.getTrustedIssuers()).length, 2);
    assert.equal(await mc.isModuleBound(slAddr), true);
    assert.equal(lc(await token.name()), lc(td.name));
  });

  it("deploys several modules incl. a duplicate (already-bound) and more modules than settings", async () => {
    const settings = platform.supplyLimitModule.interface.encodeFunctionData("setSupplyLimit", [10n]);
    const td = tokenDetails(platformAdmin.address, {
      complianceModules: [slAddr, slAddr],
      complianceSettings: [settings],
    });
    const tx = await deploy(td);
    const [ev] = await eventsOf(tx, factory, "TREXSuiteDeployed");
    const mc = await getContractAt("ModularCompliance", ev.args[5], deployer);
    assert.equal(await mc.isModuleBound(slAddr), true);
    assert.equal((await mc.getModules()).length, 1);
  });

  it("uses a supplied IRS instead of deploying a new one", async () => {
    const irsProxy0 = await deployContract(deployer, "IdentityRegistryStorageProxy", await platform.ia.getAddress());
    const irsProxy = await getContractAt("IdentityRegistryStorage", await irsProxy0.getAddress(), deployer);
    await (await irsProxy.transferOwnership(await factory.getAddress())).wait();
    const tx = await deploy(tokenDetails(platformAdmin.address, { irs: await irsProxy.getAddress() }));
    const [ev] = await eventsOf(tx, factory, "TREXSuiteDeployed");
    assert.equal(lc(ev.args[2]), lc(await irsProxy.getAddress()));
  });

  it("onlyOwner and salt uniqueness", async () => {
    const f = factory.connect(outsider);
    await expectRevert(async () => f.deployTREXSuite(salt(), tokenDetails(outsider.address), claimDetails()), OWNER_ERR);
    const s = salt();
    await (await deploy(tokenDetails(platformAdmin.address), claimDetails(), s)).wait();
    await expectRevert(async () => deploy(tokenDetails(platformAdmin.address), claimDetails(), s), "token already deployed");
  });

  it("validates claim, agent and compliance array limits", async () => {
    const td = () => tokenDetails(platformAdmin.address);
    const addrs = (n) => Array.from({ length: n }, () => randomAddress());
    await expectRevert(
      () => deploy(td(), claimDetails({ issuers: [randomAddress()], issuerClaims: [] })),
      "claim pattern not valid"
    );
    await expectRevert(
      () => deploy(td(), claimDetails({ issuers: addrs(6), issuerClaims: Array(6).fill([1]) })),
      "max 5 claim issuers at deployment"
    );
    await expectRevert(
      () => deploy(td(), claimDetails({ claimTopics: [1, 2, 3, 4, 5, 6] })),
      "max 5 claim topics at deployment"
    );
    await expectRevert(async () => deploy(tokenDetails(platformAdmin.address, { irAgents: addrs(6) })), "max 5 agents at deployment");
    await expectRevert(
      () => deploy(tokenDetails(platformAdmin.address, { tokenAgents: addrs(6) })),
      "max 5 agents at deployment"
    );
    await expectRevert(
      () => deploy(tokenDetails(platformAdmin.address, { complianceModules: addrs(31) })),
      "max 30 module actions at deployment"
    );
    await expectRevert(
      () => deploy(tokenDetails(platformAdmin.address, { complianceModules: [slAddr], complianceSettings: ["0x", "0x"] })),
      "invalid compliance pattern"
    );
  });

  it("fuzz: boundary sizes of issuers/topics/agents accept <=5 and reject >5", async () => {
    const rand = prng(2024);
    for (let i = 0; i < 8; i++) {
      const nTopics = Math.floor(rand() * 8);
      const nAgents = Math.floor(rand() * 8);
      const topics = Array.from({ length: nTopics }, (_, k) => k + 1);
      const agents = Array.from({ length: nAgents }, () => randomAddress());
      const td = tokenDetails(platformAdmin.address, { irAgents: agents });
      const cd = claimDetails({ claimTopics: topics });
      if (nTopics > 5) await expectRevert(async () => deploy(td, cd), "max 5 claim topics at deployment");
      else if (nAgents > 5) await expectRevert(async () => deploy(td, cd), "max 5 agents at deployment");
      else await (await deploy(td, cd)).wait();
    }
  });

  it("recoverContractOwnership: owner only, transfers any owned contract", async () => {
    const o = await deployContract(deployer, "ClaimTopicsRegistry");
    await (await o.init()).wait();
    await (await o.transferOwnership(await factory.getAddress())).wait();
    await expectRevert(async () => factory.connect(outsider).recoverContractOwnership(await o.getAddress(), outsider.address), OWNER_ERR);
    await (await factory.recoverContractOwnership(await o.getAddress(), aurora.address)).wait();
    assert.equal(lc(await o.owner()), lc(aurora.address));
  });

  it("setImplementationAuthority: owner only, rejects zero and incomplete IA, accepts complete IA", async () => {
    await expectRevert(async () => factory.connect(outsider).setImplementationAuthority(randomAddress()), OWNER_ERR);
    await expectRevert(async () => factory.setImplementationAuthority(ZERO), "invalid argument - zero address");
    const empty = await deployContract(deployer, "TREXImplementationAuthority", true, ZERO, ZERO);
    await expectRevert(async () => factory.setImplementationAuthority(await empty.getAddress()), "invalid Implementation Authority");
    await expectRevert(async () => deployContract(deployer, "TREXFactory", await empty.getAddress()), "invalid Implementation Authority");

    const original = await factory.getImplementationAuthority();
    const ia2 = await deployContract(deployer, "TREXImplementationAuthority", true, ZERO, ZERO);
    const impls = (await platform.ia.getContracts(V100)).toObject();
    await (await ia2.addAndUseTREXVersion(V100, impls)).wait();
    const tx = await factory.setImplementationAuthority(await ia2.getAddress());
    const [ev] = await eventsOf(tx, factory, "ImplementationAuthoritySet");
    assert.equal(lc(ev.args[0]), lc(await ia2.getAddress()));
    assert.equal(lc(await factory.getImplementationAuthority()), lc(await ia2.getAddress()));
    await (await factory.setImplementationAuthority(original)).wait();
  });
});

describe("TREXImplementationAuthority / IAFactory / AbstractProxy", () => {
  let provider;
  let deployer, platformAdmin, registrar, bndSafe, outsider, aurora, northbridge;
  let impls, factory, ia, iaFactory;

  const asIa = (c, s) => c.connect(s);

  async function newImpls() {
    return {
      tokenImplementation: await (await deployContract(deployer, "Token")).getAddress(),
      ctrImplementation: await (await deployContract(deployer, "ClaimTopicsRegistry")).getAddress(),
      irImplementation: await (await deployContract(deployer, "IdentityRegistry")).getAddress(),
      irsImplementation: await (await deployContract(deployer, "IdentityRegistryStorage")).getAddress(),
      tirImplementation: await (await deployContract(deployer, "TrustedIssuersRegistry")).getAddress(),
      mcImplementation: await (await deployContract(deployer, "ModularCompliance")).getAddress(),
    };
  }

  /** deploy a reference IA + factory + IAFactory, fully wired */
  async function deployStack() {
    const _ia = await deployContract(deployer, "TREXImplementationAuthority", true, ZERO, ZERO);
    await (await _ia.addAndUseTREXVersion(V100, impls)).wait();
    const _factory = await deployContract(deployer, "TREXFactory", await _ia.getAddress());
    await (await _ia.setTREXFactory(await _factory.getAddress())).wait();
    const _iaf = await deployContract(deployer, "IAFactory", await _factory.getAddress());
    await (await _ia.setIAFactory(await _iaf.getAddress())).wait();
    return { ia: _ia, factory: _factory, iaFactory: _iaf };
  }

  /** deploy a suite owned by `owner`; IRS is pre-deployed so the owner can hold it too */
  async function newDeal(owner, st = { ia, factory }, sharedIrs) {
    let irs = sharedIrs;
    if (!irs) {
      const p0 = await deployContract(deployer, "IdentityRegistryStorageProxy", await st.ia.getAddress());
      const p = await getContractAt("IdentityRegistryStorage", await p0.getAddress(), deployer);
      irs = await p.getAddress();
      await (await p.transferOwnership(await st.factory.getAddress())).wait();
    } else {
      const p = await getContractAt("IdentityRegistryStorage", irs, owner);
      await (await p.transferOwnership(await st.factory.getAddress())).wait();
    }
    const td = tokenDetails(owner.address, { irs });
    const tx = await st.factory.deployTREXSuite(uniqueName("ia"), td, claimDetails());
    const [ev] = await eventsOf(tx, st.factory, "TREXSuiteDeployed");
    await (await st.factory.recoverContractOwnership(irs, owner.address)).wait();
    return {
      token: ev.args[0],
      ir: ev.args[1],
      irs: ev.args[2],
      tir: ev.args[3],
      ctr: ev.args[4],
      mc: ev.args[5],
    };
  }

  const proxyIa = async (addr) => {
    const p = await getContractAt("IProxy", addr, deployer);
    return lc(await p.getImplementationAuthority());
  };
  const allIas = async (d) => [
    await proxyIa(d.token),
    await proxyIa(d.ir),
    await proxyIa(d.mc),
    await proxyIa(d.ctr),
    await proxyIa(d.tir),
    await proxyIa(d.irs),
  ];

  async function impersonate(addr) {
    await provider.send("hardhat_impersonateAccount", [addr]);
    await provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
    return new ethers.JsonRpcSigner(provider, addr);
  }

  before(async () => {
    provider = await makeProvider();
    ({ deployer, platformAdmin, registrar, bndSafe, outsider, aurora, northbridge } = await getSigners(provider));
    impls = await newImpls();
    ({ ia, factory, iaFactory } = await deployStack());
  });

  describe("construction, setTREXFactory, setIAFactory", () => {
    it("constructor stores reference flag and emits events; getters return contracts", async () => {
      const fresh = await deployContract(deployer, "TREXImplementationAuthority", true, ZERO, ZERO);
      const receipt = await fresh.deploymentTransaction().wait();
      const names = receipt.logs.map((l) => fresh.interface.parseLog(l)?.name);
      assert.ok(names.includes("ImplementationAuthoritySet"));
      assert.ok(names.includes("IAFactorySet"));
      assert.equal(await fresh.isReferenceContract(), true);
      assert.equal(await fresh.getTREXFactory(), ZERO);
      // nothing in use yet
      assert.equal(await fresh.getTokenImplementation(), ZERO);
      const v = await fresh.getCurrentVersion();
      assert.equal(v.major + v.minor + v.patch, 0n);
    });

    it("setTREXFactory: owner only, reference only, factory must point to this IA", async () => {
      const fresh = await deployContract(deployer, "TREXImplementationAuthority", true, ZERO, ZERO);
      await expectRevert(async () => asIa(fresh, outsider).setTREXFactory(await factory.getAddress()), OWNER_ERR);
      // factory's IA is `ia`, not `fresh`
      await expectRevert(async () => fresh.setTREXFactory(await factory.getAddress()), "only reference contract can call");
      // auxiliary IA cannot set
      const aux = await deployContract(deployer, "TREXImplementationAuthority", false, await factory.getAddress(), ZERO);
      await expectRevert(async () => aux.setTREXFactory(await factory.getAddress()), "only reference contract can call");
      // the reference IA can
      const tx = await ia.setTREXFactory(await factory.getAddress());
      const [ev] = await eventsOf(tx, ia, "TREXFactorySet");
      assert.equal(lc(ev.args[0]), lc(await factory.getAddress()));
      assert.equal(lc(await ia.getTREXFactory()), lc(await factory.getAddress()));
      assert.equal(lc(await ia.getReferenceContract()), lc(await ia.getAddress()));
    });

    it("setIAFactory: owner only, reference only, needs a wired factory", async () => {
      await expectRevert(async () => asIa(ia, outsider).setIAFactory(randomAddress()), OWNER_ERR);
      const unwired = await deployContract(deployer, "TREXImplementationAuthority", true, ZERO, ZERO);
      await expectRevert(async () => unwired.setIAFactory(randomAddress())); // factory zero => call reverts
      const aux = await deployContract(deployer, "TREXImplementationAuthority", false, await factory.getAddress(), ZERO);
      await expectRevert(async () => aux.setIAFactory(randomAddress()), "only reference contract can call");
      const newF = randomAddress();
      const tx = await ia.setIAFactory(newF);
      const [ev] = await eventsOf(tx, ia, "IAFactorySet");
      assert.equal(lc(ev.args[0]), lc(newF));
      await (await ia.setIAFactory(await iaFactory.getAddress())).wait();
    });
  });

  describe("version management", () => {
    it("addTREXVersion: owner only, reference only, no duplicates, no zero implementations", async () => {
      await expectRevert(async () => asIa(ia, outsider).addTREXVersion(V110, impls), OWNER_ERR);
      await expectRevert(async () => ia.addTREXVersion(V100, impls), "version already exists");
      const aux = await deployContract(deployer, "TREXImplementationAuthority", false, await factory.getAddress(), ZERO);
      await expectRevert(async () => aux.addTREXVersion(V110, impls), "ONLY reference contract can add versions");
      for (const key of Object.keys(impls)) {
        await expectRevert(async () => ia.addTREXVersion(V110, { ...impls, [key]: ZERO }), "invalid argument - zero address");
      }
      const tx = await ia.addTREXVersion(V110, impls);
      const [ev] = await eventsOf(tx, ia, "TREXVersionAdded");
      assert.ok(ev, "event emitted");
      const got = await ia.getContracts(V110);
      assert.equal(lc(got.tokenImplementation), lc(impls.tokenImplementation));
      // adding a version does not switch to it
      assert.equal((await ia.getCurrentVersion()).minor, 0n);
    });

    it("useTREXVersion: owner only, must exist, must differ from current", async () => {
      await expectRevert(async () => asIa(ia, outsider).useTREXVersion(V110), OWNER_ERR);
      await expectRevert(async () => ia.useTREXVersion(V100), "version already in use");
      await expectRevert(async () => ia.useTREXVersion({ major: 9, minor: 9, patch: 9 }), "invalid argument - non existing version");
      const tx = await ia.useTREXVersion(V110);
      const [ev] = await eventsOf(tx, ia, "VersionUpdated");
      assert.ok(ev, "event emitted");
      assert.equal((await ia.getCurrentVersion()).minor, 1n);
      await (await ia.useTREXVersion(V100)).wait();
    });

    it("addAndUseTREXVersion adds and switches; implementation getters follow current version", async () => {
      const other = await newImpls();
      await (await ia.addAndUseTREXVersion(V120, other)).wait();
      assert.equal(lc(await ia.getTokenImplementation()), lc(other.tokenImplementation));
      assert.equal(lc(await ia.getCTRImplementation()), lc(other.ctrImplementation));
      assert.equal(lc(await ia.getIRImplementation()), lc(other.irImplementation));
      assert.equal(lc(await ia.getIRSImplementation()), lc(other.irsImplementation));
      assert.equal(lc(await ia.getTIRImplementation()), lc(other.tirImplementation));
      assert.equal(lc(await ia.getMCImplementation()), lc(other.mcImplementation));
      // add-and-use of an existing version fails
      await expectRevert(async () => ia.addAndUseTREXVersion(V120, other), "version already exists");
      await (await ia.useTREXVersion(V100)).wait();
      assert.equal(lc(await ia.getTokenImplementation()), lc(impls.tokenImplementation));
    });

    it("fuzz: random versions can be added once and selected", async () => {
      const rand = prng(555);
      const seen = new Set(["1.0.0", "1.1.0", "1.2.0"]);
      for (let i = 0; i < 6; i++) {
        const v = {
          major: 2 + Math.floor(rand() * 3),
          minor: Math.floor(rand() * 3),
          patch: Math.floor(rand() * 3),
        };
        const key = `${v.major}.${v.minor}.${v.patch}`;
        if (seen.has(key)) {
          await expectRevert(async () => ia.addTREXVersion(v, impls), "version already exists");
        } else {
          seen.add(key);
          await (await ia.addTREXVersion(v, impls)).wait();
          await (await ia.useTREXVersion(v)).wait();
          const cur = await ia.getCurrentVersion();
          assert.deepEqual([cur.major, cur.minor, cur.patch].map(Number), [v.major, v.minor, v.patch]);
        }
      }
      await (await ia.useTREXVersion(V100)).wait();
    });

    it("fetchVersion: only on auxiliary IA, once per version, copies reference contracts", async () => {
      await expectRevert(async () => ia.fetchVersion(V100), "cannot call on reference contract");
      const aux = await deployContract(deployer, "TREXImplementationAuthority", false, await factory.getAddress(), await iaFactory.getAddress());
      const tx = await aux.fetchVersion(V110);
      const [ev] = await eventsOf(tx, aux, "TREXVersionFetched");
      assert.ok(ev, "event emitted");
      const got = await aux.getContracts(V110);
      assert.equal(lc(got.irImplementation), lc(impls.irImplementation));
      await expectRevert(async () => aux.fetchVersion(V110), "version fetched already");
      assert.equal(await aux.isReferenceContract(), false);
      assert.equal(lc(await aux.getReferenceContract()), lc(await ia.getAddress()));
    });
  });

  describe("changeImplementationAuthority + IAFactory", () => {
    it("rejects zero token, non-owners, and new-IA deployment from an auxiliary IA", async () => {
      await expectRevert(async () => ia.changeImplementationAuthority(ZERO, randomAddress()), "invalid argument - zero address");
      const aux = await deployContract(deployer, "TREXImplementationAuthority", false, await factory.getAddress(), await iaFactory.getAddress());
      await expectRevert(async () => aux.changeImplementationAuthority(randomAddress(), ZERO), "only reference contract can deploy new IAs");
      const d = await newDeal(platformAdmin);
      await expectRevert(async () => asIa(ia, outsider).changeImplementationAuthority(d.token, ZERO), "caller NOT owner of all contracts impacted");
      // each of the suite contracts must be owned by the caller: take away ownership of one at a time
      for (const key of ["token", "ir", "mc", "irs", "ctr", "tir"]) {
        const d2 = await newDeal(platformAdmin);
        const c = new ethers.Contract(d2[key], ["function transferOwnership(address)"], platformAdmin);
        await (await c.transferOwnership(outsider.address)).wait();
        await expectRevert(
          () => asIa(ia, platformAdmin).changeImplementationAuthority(d2.token, ZERO),
          "caller NOT owner of all contracts impacted"
        );
      }
    });

    it("deploys a fresh auxiliary IA via IAFactory and repoints the whole suite", async () => {
      const d = await newDeal(platformAdmin);
      assert.deepEqual(await allIas(d), Array(6).fill(lc(await ia.getAddress())));
      const tx = await asIa(ia, platformAdmin).changeImplementationAuthority(d.token, ZERO);
      const [ev] = await eventsOf(tx, ia, "ImplementationAuthorityChanged");
      const newIa = ev.args[1];
      assert.equal(lc(ev.args[0]), lc(d.token));
      assert.notEqual(lc(newIa), lc(await ia.getAddress()));
      assert.deepEqual(await allIas(d), Array(6).fill(lc(newIa)));
      assert.equal(await iaFactory.deployedByFactory(newIa), true);
      assert.equal(await iaFactory.deployedByFactory(randomAddress()), false);
      const aux = await getContractAt("TREXImplementationAuthority", newIa, platformAdmin);
      assert.equal(await aux.isReferenceContract(), false);
      assert.equal(lc(await aux.owner()), lc(platformAdmin.address));
      assert.equal(lc(await aux.getTREXFactory()), lc(await factory.getAddress()));
      assert.equal((await aux.getCurrentVersion()).major, 1n);
      assert.equal(lc(await aux.getTokenImplementation()), lc(impls.tokenImplementation));
      // token still functional through its new authority
      const token = await getContractAt("Token", d.token, platformAdmin);
      assert.ok((await token.name()).length > 0);
    });

    it("moves a suite back to the reference IA and to another factory-deployed IA", async () => {
      const d = await newDeal(platformAdmin);
      await (await asIa(ia, platformAdmin).changeImplementationAuthority(d.token, ZERO)).wait();
      const auxAddr = (await allIas(d))[0];
      const aux = await getContractAt("TREXImplementationAuthority", auxAddr, platformAdmin);

      // a second suite gets its own IA
      const d2 = await newDeal(platformAdmin);
      await (await asIa(ia, platformAdmin).changeImplementationAuthority(d2.token, ZERO)).wait();
      const aux2 = (await allIas(d2))[0];

      // aux -> another factory-deployed IA (same version)
      await (await aux.changeImplementationAuthority(d.token, aux2)).wait();
      assert.deepEqual(await allIas(d), Array(6).fill(lc(aux2)));

      // aux2 -> reference IA (allowed because it equals the reference contract)
      const aux2c = await getContractAt("TREXImplementationAuthority", aux2, platformAdmin);
      await (await aux2c.changeImplementationAuthority(d.token, await ia.getAddress())).wait();
      assert.deepEqual(await allIas(d), Array(6).fill(lc(await ia.getAddress())));
    });

    it("validates the target IA: version, reference status, factory origin", async () => {
      const d = await newDeal(platformAdmin);
      const call = (target) => asIa(ia, platformAdmin).changeImplementationAuthority(d.token, target);

      // different version => mismatch
      const other = await deployContract(deployer, "TREXImplementationAuthority", false, await factory.getAddress(), await iaFactory.getAddress());
      await (await other.fetchVersion(V110)).wait();
      await (await other.useTREXVersion(V110)).wait();
      await expectRevert(async () => call(await other.getAddress()), "version of new IA has to be the same as current IA");

      // another reference IA with the same version => not THE reference contract
      const ref2 = await deployContract(deployer, "TREXImplementationAuthority", true, ZERO, ZERO);
      await (await ref2.addAndUseTREXVersion(V100, impls)).wait();
      await expectRevert(async () => call(await ref2.getAddress()), "new IA is NOT reference contract");

      // same version, auxiliary but not deployed by the factory => invalid
      const rogue = await deployContract(deployer, "TREXImplementationAuthority", false, await factory.getAddress(), await iaFactory.getAddress());
      await (await rogue.fetchVersion(V100)).wait();
      await (await rogue.useTREXVersion(V100)).wait();
      await expectRevert(async () => call(await rogue.getAddress()), "invalid IA");

      // owner of the reference IA changes version, mismatch against old suites' IA
      await (await ia.useTREXVersion(V110)).wait();
      try {
        const aux = await deployContract(deployer, "TREXImplementationAuthority", false, await factory.getAddress(), await iaFactory.getAddress());
        await (await aux.fetchVersion(V110)).wait();
        await (await aux.useTREXVersion(V110)).wait();
        await expectRevert(async () => call(await aux.getAddress()), "invalid IA"); // same version, not by factory
      } finally {
        await (await ia.useTREXVersion(V100)).wait();
      }
    });

    it("shared IRS already moved: skips re-pointing the IRS on the second suite", async () => {
      const d1 = await newDeal(platformAdmin);
      const d2 = await newDeal(platformAdmin, undefined, d1.irs);
      assert.equal(lc(d2.irs), lc(d1.irs));
      await (await asIa(ia, platformAdmin).changeImplementationAuthority(d1.token, ZERO)).wait();
      const newIa1 = (await allIas(d1))[0];
      assert.equal(await proxyIa(d1.irs), newIa1);
      // d2's other contracts still on the reference IA, IRS already on newIa1
      await (await asIa(ia, platformAdmin).changeImplementationAuthority(d2.token, ZERO)).wait();
      const newIa2 = await proxyIa(d2.token);
      assert.notEqual(newIa2, newIa1);
      assert.equal(await proxyIa(d2.ir), newIa2);
      assert.equal(await proxyIa(d2.irs), newIa1, "IRS must not be changed again");
    });

    it("version upgrade on the reference IA is picked up by suites still pointing to it", async () => {
      const st = await deployStack();
      const d = await newDeal(platformAdmin, st);
      const token = await getContractAt("Token", d.token, platformAdmin);
      const before = await token.name();
      const other = await newImpls();
      await (await st.ia.addAndUseTREXVersion(V110, other)).wait();
      assert.equal(lc(await st.ia.getTokenImplementation()), lc(other.tokenImplementation));
      assert.equal(await token.name(), before);
    });

    it("IAFactory.deployIA: only the reference IA of the factory can call it", async () => {
      await expectRevert(async () => iaFactory.deployIA(randomAddress()), "only reference IA can deploy");
      const d = await newDeal(platformAdmin);
      await expectRevert(async () => iaFactory.connect(outsider).deployIA(d.token), "only reference IA can deploy");
    });

    it("IAFactory.deployIA succeeds when called by the reference IA itself", async () => {
      const d = await newDeal(platformAdmin);
      const refSigner = await impersonate(await ia.getAddress());
      const tx = await iaFactory.connect(refSigner).deployIA(d.token);
      const [ev] = await eventsOf(tx, iaFactory, "ImplementationAuthorityDeployed");
      assert.equal(await iaFactory.deployedByFactory(ev.args[0]), true);
      const newIa = await getContractAt("TREXImplementationAuthority", ev.args[0], deployer);
      assert.equal(lc(await newIa.owner()), lc(platformAdmin.address));
    });
  });

  describe("AbstractProxy (via suite proxies)", () => {
    it("setImplementationAuthority: only current IA, non-zero, complete IA; emits event", async () => {
      const d = await newDeal(platformAdmin);
      const token = await getContractAt("TokenProxy", d.token, outsider);
      const currentIa = await token.getImplementationAuthority();
      assert.equal(lc(currentIa), lc(await ia.getAddress()));

      await expectRevert(async () => token.setImplementationAuthority(randomAddress()), "only current implementationAuthority can call");

      const iaSigner = await impersonate(currentIa);
      const asIA = token.connect(iaSigner);
      await expectRevert(async () => asIA.setImplementationAuthority(ZERO), "invalid argument - zero address");
      const empty = await deployContract(deployer, "TREXImplementationAuthority", true, ZERO, ZERO);
      await expectRevert(async () => asIA.setImplementationAuthority(await empty.getAddress()), "invalid Implementation Authority");

      const st = await deployStack();
      const tx = await asIA.setImplementationAuthority(await st.ia.getAddress());
      const [ev] = await eventsOf(tx, token, "ImplementationAuthoritySet");
      assert.equal(lc(ev.args[0]), lc(await st.ia.getAddress()));
      assert.equal(lc(await token.getImplementationAuthority()), lc(await st.ia.getAddress()));
    });

    it("every proxy type exposes the same authority and rejects outside callers", async () => {
      const d = await newDeal(platformAdmin);
      for (const [artifact, key] of [
        ["IdentityRegistryProxy", "ir"],
        ["ModularComplianceProxy", "mc"],
        ["ClaimTopicsRegistryProxy", "ctr"],
        ["TrustedIssuersRegistryProxy", "tir"],
        ["IdentityRegistryStorageProxy", "irs"],
      ]) {
        const p = await getContractAt(artifact, d[key], outsider);
        assert.equal(lc(await p.getImplementationAuthority()), lc(await ia.getAddress()));
        await expectRevert(async () => p.setImplementationAuthority(await ia.getAddress()), "only current implementationAuthority can call");
      }
    });
  });
});
