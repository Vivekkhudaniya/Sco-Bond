# Foundry Test Roadmap — SCO Bond (ERC-3643)

A comprehensive plan for testing the modified T-REX contracts end-to-end,
ordered by dependency chain: each phase builds on the previous one.

---

## Testing Strategy

**Approach:** Bottom-up, mirroring the 12-step deployment flow from
`Factory_Function_Flow_and_Architecture.md`. Each test file deploys
only what it needs and verifies one contract layer at a time.

**Framework:** Foundry (`forge test`), Solidity 0.8.17.

**Shared fixture:** A `BaseTest` helper that deploys the 6 implementations +
ImplementationAuthority + Factory + Gateway in `setUp()`, so every test file
starts from a working platform. Individual tests then deploy deals on top.

```
test/
├── BaseTest.sol              ← shared setUp (Steps 1-4)
├── Phase1_Factory.t.sol      ← TREXFactory + Gateway (Steps 3-7)
├── Phase2_Whitelist.t.sol    ← IdentityRegistry + whitelist trick (Step 8)
├── Phase3_Token.t.sol        ← Mint, pause, freeze, compliance (Step 9)
├── Phase4_Compliance.t.sol   ← SupplyLimitModule edge cases (Step 5+9)
├── Phase5_DVD.t.sol          ← DVDTransferManager full flow (Steps 10-12)
├── Phase6_EndToEnd.t.sol     ← All 12 steps in one test (golden path)
└── Phase7_EdgeCases.t.sol    ← Adversarial scenarios across all contracts
```

---

## Phase 0: BaseTest (Shared Fixture)

**File:** `test/BaseTest.sol`
**Purpose:** Deploy the platform infrastructure once so every test inherits a ready state.

| What it deploys | Corresponds to |
|-----------------|----------------|
| 6 implementation contracts (Token, IR, IRS, CTR, TIR, MC) | Step 1 |
| TREXImplementationAuthority + `addAndUseTREXVersion` | Step 2 |
| TREXFactory (our modified, no IdFactory) | Step 3 |
| TREXGateway + `transferOwnership` + `addDeployer` | Step 4 |
| SupplyLimitModule impl + ModuleProxy + `initialize()` | Step 5 |
| MockCashToken + DVDTransferManager | Step 6 |

**Exposes:**
- All contract instances as `internal` variables
- Helper `_deployDeal()` that calls `gateway.deployTREXSuite(...)` with sensible defaults
  and returns `(token, ir, irs, ctr, tir, mc)` proxy addresses parsed from event logs
- Helper `_whitelist(address[] memory wallets)` for quick investor registration
- Test wallets: `deployer`, `platformAdmin`, `registrar`, `bndSafe`,
  `aurora`, `northbridge`, `meridian`

---

## Phase 1: Factory & Gateway

**File:** `test/Phase1_Factory.t.sol`
**Covers:** Steps 3, 4, 7 — the deal deployment machinery.

### 1.1 TREXFactory — deployTREXSuite

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | `test_deployTREXSuite_deploys6Proxies` | All 6 proxy addresses in `TREXSuiteDeployed` event are non-zero and unique |
| 2 | `test_deployTREXSuite_setsOwnership` | Token, IR, TIR, CTR, MC owners are the `tokenDetails.owner` |
| 3 | `test_deployTREXSuite_registersAgents` | `registrarSafe` is IR agent, `bndSafe` is Token agent |
| 4 | `test_deployTREXSuite_bindsComplianceModule` | SupplyLimitModule is bound to the deal's ModularCompliance, and supply limit is set to 5000 |
| 5 | `test_deployTREXSuite_bindsIRStoIR` | IRS is linked to IR (check `irs.linkedIdentityRegistries()`) |
| 6 | `test_deployTREXSuite_tokenAgentIsIR` | Token's agent list includes the IR proxy (added by factory at line 146) |
| 7 | `test_deployTREXSuite_onchainIDIsZero` | Token's `onchainID()` returns `address(0)` |
| 8 | `test_deployTREXSuite_emptyClaimTopics` | CTR has zero claim topics, TIR has zero trusted issuers |
| 9 | `test_deployTREXSuite_tokenStartsPaused` | Token is paused after deployment |
| 10 | `test_deployTREXSuite_duplicateSaltReverts` | Deploying same token name + owner twice reverts |

### 1.2 TREXGateway — access control

| # | Test | What it verifies |
|---|------|-----------------|
| 11 | `test_gateway_onlyApprovedDeployerCanDeploy` | Non-approved address reverts with expected error |
| 12 | `test_gateway_addRemoveDeployer` | `addDeployer` / `removeDeployer` toggle access |
| 13 | `test_gateway_ownerCanAlwaysDeploy` | Gateway owner can deploy even without being in deployer list |
| 14 | `test_gateway_publicDeploymentMode` | When `publicDeploymentStatus = true`, anyone can deploy |

### 1.3 TREXFactory — our ONCHAINID removal

| # | Test | What it verifies |
|---|------|-----------------|
| 15 | `test_factory_constructorTakesOneParam` | Factory deploys with only `(implementationAuthority)`, no `idFactory` |
| 16 | `test_factory_noIdFactoryStorage` | No `getIdFactory()` function exists (low-level call returns false) |
| 17 | `test_factory_zeroONCHAINID_noIdentityCreated` | When `ONCHAINID = address(0)`, no identity contract is deployed (compare code size at token's onchainID address) |

---

## Phase 2: Whitelist (IdentityRegistry)

**File:** `test/Phase2_Whitelist.t.sol`
**Covers:** Step 8 — the whitelist trick (empty claim topics = `isVerified` short-circuits).

### 2.1 Registration

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | `test_batchRegisterIdentity_success` | 4 wallets registered, `contains(wallet)` returns true for each |
| 2 | `test_batchRegisterIdentity_onlyAgent` | Non-agent caller reverts |
| 3 | `test_batchRegisterIdentity_duplicateReverts` | Registering same wallet twice reverts |
| 4 | `test_registerIdentity_single` | Single registration works (for adding a late investor) |
| 5 | `test_deleteIdentity_removesFromWhitelist` | After deletion, `contains(wallet)` returns false |

### 2.2 The whitelist trick — isVerified

| # | Test | What it verifies |
|---|------|-----------------|
| 6 | `test_isVerified_trueForRegistered` | `isVerified(wallet)` returns true when wallet is registered and claim topics are empty |
| 7 | `test_isVerified_falseForUnregistered` | `isVerified(randomAddress)` returns false |
| 8 | `test_isVerified_falseAfterDeletion` | Remove wallet → `isVerified` returns false |
| 9 | `test_isVerified_shortCircuit_noClaimsChecked` | With empty CTR, no claim issuer lookup happens (the identity address doesn't need to be a real contract) |

### 2.3 Identity storage linkage

| # | Test | What it verifies |
|---|------|-----------------|
| 10 | `test_irs_boundToIR` | `irs.linkedIdentityRegistries()` includes the IR proxy |
| 11 | `test_irs_onlyBoundIR_canModify` | Direct call to IRS from non-IR address reverts |

---

## Phase 3: Token (Mint, Pause, Transfer, Freeze)

**File:** `test/Phase3_Token.t.sol`
**Covers:** Step 9 — minting, pausing, and the token's built-in guards.

### 3.1 Mint

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | `test_mint_toWhitelistedAddress` | `mint(bndSafe, 5000)` succeeds, balance = 5000 |
| 2 | `test_mint_toNonWhitelisted_reverts` | `mint(randomAddr, 100)` reverts (isVerified fails) |
| 3 | `test_mint_onlyTokenAgent` | Non-agent caller reverts |
| 4 | `test_mint_beyondSupplyLimit_reverts` | `mint(bndSafe, 5001)` reverts (SupplyLimitModule rejects) |

### 3.2 Pause / Unpause

| # | Test | What it verifies |
|---|------|-----------------|
| 5 | `test_token_startsPaused` | `paused()` is true after deployment |
| 6 | `test_transfer_whilePaused_reverts` | `transfer()` reverts when paused |
| 7 | `test_unpause_enablesTransfer` | After `unpause()`, `transfer()` works |
| 8 | `test_unpause_onlyAgent` | Non-agent cannot unpause |

### 3.3 Transfer

| # | Test | What it verifies |
|---|------|-----------------|
| 9 | `test_transfer_toWhitelisted` | B&D → Aurora succeeds, balances update |
| 10 | `test_transfer_toNonWhitelisted_reverts` | B&D → random address reverts |
| 11 | `test_transferFrom_withApproval` | With `approve()`, third party can move tokens |
| 12 | `test_transferFrom_withoutApproval_reverts` | Without approval, `transferFrom` reverts |

### 3.4 Freeze

| # | Test | What it verifies |
|---|------|-----------------|
| 13 | `test_freezeAddress_blocksTransfer` | Frozen sender cannot transfer |
| 14 | `test_freezeAddress_blocksReceive` | Frozen receiver cannot receive via transfer |
| 15 | `test_unfreezeAddress_restoresTransfer` | After unfreeze, transfers work again |
| 16 | `test_freezePartialBalance` | `freezePartialTokens()` blocks only the frozen amount |

### 3.5 Burn (Redemption path)

| # | Test | What it verifies |
|---|------|-----------------|
| 17 | `test_burn_noIsVerifiedCheck` | Agent can burn from any holder — no whitelist check |
| 18 | `test_burn_noCanTransferCheck` | Burn works even if compliance would block a transfer |
| 19 | `test_burn_noPausedCheck` | Burn works even when token is paused |
| 20 | `test_burn_reducesSupply` | Total supply decreases after burn |
| 21 | `test_burn_onlyAgent` | Non-agent cannot burn |

### 3.6 Forced transfer

| # | Test | What it verifies |
|---|------|-----------------|
| 22 | `test_forcedTransfer_byAgent` | Agent can move tokens between any whitelisted addresses |
| 23 | `test_forcedTransfer_ignoresPaused` | Works when token is paused |
| 24 | `test_forcedTransfer_ignoresFrozen` | Works when sender is frozen |
| 25 | `test_forcedTransfer_toNonWhitelisted_reverts` | Still checks `isVerified(to)` |

---

## Phase 4: Compliance Module (SupplyLimitModule)

**File:** `test/Phase4_Compliance.t.sol`
**Covers:** Step 5 + interactions with Step 9 — the module proxy and supply cap.

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | `test_supplyLimit_setViaFactory` | After deal deployment, `getSupplyLimit()` returns 5000 |
| 2 | `test_supplyLimit_blocksMintAboveCap` | Minting 5001 reverts |
| 3 | `test_supplyLimit_allowsMintAtCap` | Minting exactly 5000 succeeds |
| 4 | `test_supplyLimit_transferDoesNotChangeSupply` | Transfer between holders doesn't hit the cap |
| 5 | `test_supplyLimit_burnThenMintAgain` | Burn 1000, then mint 1000 — works because supply dropped |
| 6 | `test_supplyLimit_onlyComplianceCanSet` | Direct call to `setSupplyLimit()` from non-compliance reverts |
| 7 | `test_moduleProxy_delegatesToImpl` | Proxy correctly delegates calls to SupplyLimitModule implementation |
| 8 | `test_moduleProxy_initializeOnlyOnce` | Second `initialize()` call reverts |

---

## Phase 5: DVD Transfer Manager (Atomic Swap)

**File:** `test/Phase5_DVD.t.sol`
**Covers:** Steps 10-12 — funding, initiating, and settling DVD transfers.

### 5.1 Initiate

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | `test_initiate_storesOffer` | After `initiateDVDTransfer`, the transfer exists in storage |
| 2 | `test_initiate_incrementsNonce` | `txNonce` increases by 1 after each initiation |
| 3 | `test_initiate_emitsEvent` | `DVDTransferInitiated` event is emitted with correct transferID |
| 4 | `test_initiate_zeroCounterpart_reverts` | Counterpart = `address(0)` reverts |
| 5 | `test_initiate_insufficientBalance_reverts` | B&D has fewer bonds than offered — reverts |
| 6 | `test_initiate_noAllowance_reverts` | B&D hasn't approved DVD — reverts |

### 5.2 Calculate transfer ID

| # | Test | What it verifies |
|---|------|-----------------|
| 7 | `test_calculateTransferID_deterministic` | Same inputs always produce the same ID |
| 8 | `test_calculateTransferID_uniquePerNonce` | Different nonce → different ID |
| 9 | `test_calculateTransferID_matchesStoredID` | Calculated ID matches what `initiateDVDTransfer` stored |

### 5.3 Take (settle)

| # | Test | What it verifies |
|---|------|-----------------|
| 10 | `test_take_bondsMoveToBuyer` | After settlement, Aurora has 2000 bonds |
| 11 | `test_take_cashMovesToSeller` | After settlement, B&D has the EURd |
| 12 | `test_take_deletesTransfer` | Transfer is removed from storage after settlement |
| 13 | `test_take_emitsEvent` | `DVDTransferExecuted` event emitted |
| 14 | `test_take_onlyCounterpartOrAgent` | Random caller cannot settle |
| 15 | `test_take_investorNotWhitelisted_reverts` | If investor was removed from whitelist before settlement, entire swap reverts |
| 16 | `test_take_tokenPaused_reverts` | If token is re-paused, bond leg fails → entire swap reverts |
| 17 | `test_take_insufficientCash_reverts` | If investor spent their cash elsewhere, swap reverts |
| 18 | `test_take_sameTwice_reverts` | Settling the same transferID again reverts (already deleted) |

### 5.4 Cancel

| # | Test | What it verifies |
|---|------|-----------------|
| 19 | `test_cancel_byMaker` | B&D can cancel their own pending offer |
| 20 | `test_cancel_byCounterpart` | Investor can cancel an offer made to them |
| 21 | `test_cancel_deletesTransfer` | Transfer removed from storage after cancel |
| 22 | `test_cancel_randomCaller_reverts` | Unrelated address cannot cancel |

---

## Phase 6: End-to-End (Golden Path)

**File:** `test/Phase6_EndToEnd.t.sol`
**Covers:** All 12 steps in a single test — the happy path from deployment to settlement.

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | `test_fullFlow_3InvestorDeal` | Platform setup → deal deployment → whitelist 4 addresses → mint 5000 bonds → unpause → fund 3 investors with EURd → approve DVD → 3x initiateDVDTransfer → 3x takeDVDTransfer. Final state: B&D has 0 bonds + all cash, Aurora has 2000, Northbridge has 1750, Meridian has 1250 bonds |
| 2 | `test_fullFlow_balancesAfterSettlement` | B&D bond balance = 0, total EURd received = 499,500,000 (sum of all 3 trades) |
| 3 | `test_fullFlow_totalSupplyUnchanged` | Token total supply is still 5000 after all DVD swaps |

---

## Phase 7: Edge Cases & Adversarial Scenarios

**File:** `test/Phase7_EdgeCases.t.sol`
**Covers:** Cross-cutting failure modes that span multiple contracts.

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | `test_mintBeforeWhitelist_reverts` | Cannot mint to B&D before registering them |
| 2 | `test_dvdBeforeUnpause_reverts` | DVD swap fails if token is still paused |
| 3 | `test_removeFromWhitelistBlocksFutureDVD` | Delete investor from whitelist → new DVD swap to them fails |
| 4 | `test_removeFromWhitelistDoesNotAffectBalance` | Deleting from whitelist doesn't burn existing tokens |
| 5 | `test_freezeBndBlocksDVDInitiate` | If B&D is frozen, `initiateDVDTransfer` or `takeDVDTransfer` fails on bond leg |
| 6 | `test_twoDeals_separateProxies` | Deploy two deals — each gets independent token, IR, compliance |
| 7 | `test_twoDeals_sharedSupplyModule` | Both deals share the same SupplyLimitModule proxy but have independent limits |
| 8 | `test_redeployAfterBurn_newDeal` | Burn all bonds, deploy new deal with fresh supply — works |
| 9 | `test_dvdPartialFill_notSupported` | DVD is all-or-nothing — cannot partially fill |
| 10 | `test_agentTransferVsDVD` | Token agent can `forcedTransfer` bonds without DVD, bypassing pause/freeze |

---

## Execution Order

```
Phase 0 (BaseTest)          ← shared, no tests of its own
    │
    ├── Phase 1 (Factory)   ← validates the deployment machinery works
    │
    ├── Phase 2 (Whitelist) ← validates identity registry + isVerified trick
    │
    ├── Phase 3 (Token)     ← validates mint/transfer/burn/freeze guards
    │
    ├── Phase 4 (Compliance)← validates supply cap module
    │
    ├── Phase 5 (DVD)       ← validates atomic swap (depends on Phases 2-4)
    │
    ├── Phase 6 (E2E)       ← golden path through all 12 steps
    │
    └── Phase 7 (Edge)      ← adversarial cross-cutting scenarios
```

Run all: `forge test -vvv`
Run one phase: `forge test --match-path test/Phase1_Factory.t.sol -vvv`
Run one test: `forge test --match-test test_mint_toWhitelistedAddress -vvv`

---

## Test Count Summary

| Phase | File | Tests |
|-------|------|-------|
| 1 | Phase1_Factory.t.sol | 17 |
| 2 | Phase2_Whitelist.t.sol | 11 |
| 3 | Phase3_Token.t.sol | 25 |
| 4 | Phase4_Compliance.t.sol | 8 |
| 5 | Phase5_DVD.t.sol | 22 |
| 6 | Phase6_EndToEnd.t.sol | 3 |
| 7 | Phase7_EdgeCases.t.sol | 10 |
| **Total** | | **96** |

---

## Notes

- **No mocks.** Every test deploys real contracts on Foundry's local EVM. The platform
  infrastructure is shared via `BaseTest.setUp()`, and each test deploys its own deal
  for isolation.

- **ONCHAINID removal is tested explicitly** in Phase 1 (tests 15-17). We verify the
  constructor signature changed, the storage slot is gone, and no identity contract
  is created.

- **The whitelist trick is tested explicitly** in Phase 2 (tests 6-9). We prove that
  empty claim topics make `isVerified` depend solely on IdentityRegistryStorage.

- **`burn()` has no guards** — Phase 3 tests 17-20 prove this. This is the redemption
  path: at maturity, B&D (token agent) burns bonds from each investor without needing
  them to be whitelisted, unfrozen, or the token unpaused.

- **DVD atomicity** — Phase 5 tests 15-18 verify that if either leg would fail, the
  entire transaction reverts and nothing moves.
