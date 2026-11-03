# TREXFactory — Function Flow & Architecture Diagram

A step-by-step walkthrough of which function gets triggered, what parameters are passed,
and how contracts interact with each other — from deployment to settlement.

---

## Architecture Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        PLATFORM SETUP (Deploy Once)                             │
│                                                                                 │
│   Step 1: Deploy 6 Implementation Contracts (master copies, never used directly)│
│   ┌──────────┐ ┌──────────────────┐ ┌────────────────────────┐                  │
│   │  Token    │ │ IdentityRegistry │ │ IdentityRegistryStorage│                  │
│   └────┬─────┘ └────────┬─────────┘ └───────────┬────────────┘                  │
│   ┌────┴─────────┐ ┌────┴───────────────┐ ┌─────┴──────────────┐               │
│   │ClaimTopics   │ │TrustedIssuers      │ │ModularCompliance   │               │
│   │Registry      │ │Registry            │ │                    │               │
│   └────┬─────────┘ └────┬───────────────┘ └─────┬──────────────┘               │
│        │                │                       │                               │
│        └────────────────┼───────────────────────┘                               │
│                         ▼                                                       │
│   Step 2: ┌─────────────────────────────────┐                                   │
│           │ TREXImplementationAuthority      │                                   │
│           │ "version 1.0.0 uses these 6"    │                                   │
│           └──────────────┬──────────────────┘                                   │
│                          ▼                                                      │
│   Step 3: ┌─────────────────────────────────┐                                   │
│           │ TREXFactory (our modified one)   │                                   │
│           │ knows which implementations      │                                   │
│           │ to use for each deal             │                                   │
│           └──────────────┬──────────────────┘                                   │
│                          ▼                                                      │
│   Step 4: ┌─────────────────────────────────┐                                   │
│           │ TREXGateway                      │                                   │
│           │ "front door" — access control    │                                   │
│           │ only approved deployers can      │                                   │
│           │ create deals through me          │                                   │
│           └──────────────┬──────────────────┘                                   │
│                          │                                                      │
│   Step 5: ┌──────────────┴──────────────────┐                                   │
│           │ SupplyLimitModule (behind proxy) │                                   │
│           │ caps total bonds at 5,000        │                                   │
│           └─────────────────────────────────┘                                   │
│                                                                                 │
│   Step 6: ┌─────────────────┐  ┌────────────────────┐                           │
│           │ MockCashToken   │  │ DVDTransferManager  │                           │
│           │ test EURd token │  │ atomic swap engine  │                           │
│           │ (6 decimals)    │  │ bonds ↔ cash        │                           │
│           └─────────────────┘  └────────────────────┘                           │
└─────────────────────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────────┐
│                     CREATE A DEAL (One Transaction)                              │
│                                                                                 │
│   Step 7: Platform Admin calls gateway.deployTREXSuite(...)                     │
│                                                                                 │
│   ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                    │
│   │Platform Admin│────▶│ TREXGateway  │────▶│ TREXFactory  │                    │
│   │   (caller)   │     │ (checks if   │     │ (deploys 6   │                    │
│   └──────────────┘     │  approved)   │     │  proxies)    │                    │
│                        └──────────────┘     └──────┬───────┘                    │
│                                                    │                            │
│                    ┌───────────────────────────────┬┼──────────────────────┐     │
│                    ▼               ▼               ▼▼          ▼          ▼     │
│              ┌──────────┐  ┌────────────┐  ┌──────────┐ ┌─────────┐┌────────┐  │
│              │  Token   │  │ Identity   │  │Identity  │ │Claim    ││Trusted │  │
│              │  Proxy   │  │ Registry   │  │Registry  │ │Topics   ││Issuers │  │
│              │          │  │ Proxy      │  │Storage   │ │Registry ││Registry│  │
│              │          │  │            │  │Proxy     │ │Proxy    ││Proxy   │  │
│              └──────────┘  └────────────┘  └──────────┘ └─────────┘└────────┘  │
│                                                                                 │
│              ┌──────────────────┐                                                │
│              │ModularCompliance │  (all 6 deployed + linked in ONE transaction)  │
│              │Proxy             │                                                │
│              └──────────────────┘                                                │
└─────────────────────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────────┐
│                        RUN THE DEAL (Settlement)                                │
│                                                                                 │
│   Step 8: Registrar writes the whitelist                                        │
│   ┌───────────┐      batchRegisterIdentity()       ┌──────────────────┐         │
│   │ Registrar │───────────────────────────────────▶│ IdentityRegistry │         │
│   │   Safe    │  (wallets, wallets, [0,0,0,0])     │    (whitelist)   │         │
│   └───────────┘                                    └──────────────────┘         │
│                                                                                 │
│   Step 9: B&D mints bonds and unpauses                                          │
│   ┌───────────┐      mint(BND_SAFE, 5000)          ┌──────────────────┐         │
│   │  B&D      │───────────────────────────────────▶│     Token        │         │
│   │  Safe     │      unpause()                     │  (bond token)    │         │
│   └───────────┘                                    └──────────────────┘         │
│                                                                                 │
│   Step 10: Fund investors + set allowances                                      │
│   ┌───────────┐      cash.approve(dvd, amount)     ┌──────────────────┐         │
│   │ Investors │───────────────────────────────────▶│ MockCashToken    │         │
│   └───────────┘                                    └──────────────────┘         │
│   ┌───────────┐      token.approve(dvd, 5000)      ┌──────────────────┐         │
│   │  B&D      │───────────────────────────────────▶│     Token        │         │
│   └───────────┘                                    └──────────────────┘         │
│                                                                                 │
│   Step 11: B&D offers each trade                                                │
│   ┌───────────┐    initiateDVDTransfer(token,      ┌──────────────────┐         │
│   │  B&D      │     amount, investor, cash,       ▶│DVDTransferManager│         │
│   │  Safe     │     cashAmount)                    │  (creates offer) │         │
│   └───────────┘                                    └──────────────────┘         │
│                                                                                 │
│   Step 12: Investor accepts — ATOMIC SWAP                                       │
│   ┌───────────┐    takeDVDTransfer(transferID)     ┌──────────────────┐         │
│   │ Investor  │──────────────────────────────────▶│DVDTransferManager│         │
│   └───────────┘                                    │                  │         │
│                                                    │  ┌────────────┐ │         │
│                    bonds: B&D → Investor ◀─────────│──│ Bond leg   │ │         │
│                    cash: Investor → B&D  ◀─────────│──│ Cash leg   │ │         │
│                                                    │  └────────────┘ │         │
│                                                    │ Both move or    │         │
│                                                    │ neither moves   │         │
│                                                    └──────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Function Triggers and Parameters

---

### STEP 1: Deploy the 6 implementation contracts

These are plain `new` deployments. No constructor parameters needed.

```
WHO CALLS:    Platform Admin (deployer wallet)
WHAT:         Deploy each contract individually
```

| # | Contract deployed | Constructor params | What happens |
|---|---|---|---|
| 1a | `Token` | none | Master copy of bond token code is deployed |
| 1b | `IdentityRegistry` | none | Master copy of identity registry code |
| 1c | `IdentityRegistryStorage` | none | Master copy of storage code |
| 1d | `ClaimTopicsRegistry` | none | Master copy of claim topics code |
| 1e | `TrustedIssuersRegistry` | none | Master copy of trusted issuers code |
| 1f | `ModularCompliance` | none | Master copy of compliance code |

**Result:** 6 contract addresses. These are templates — never called directly by users.

---

### STEP 2: Deploy TREXImplementationAuthority and register the code

```
WHO CALLS:    Platform Admin
FUNCTION:     new TREXImplementationAuthority(true, address(0), address(0))
```

| Parameter | Value | Meaning |
|---|---|---|
| `referenceStatus` | `true` | This is the main/reference IA (not a subsidiary) |
| `trexFactory` | `address(0)` | Factory not deployed yet — we set it later |
| `iaFactory` | `address(0)` | We don't use the IAFactory feature |

**Then register the 6 implementations:**

```
WHO CALLS:    Platform Admin (IA owner)
FUNCTION:     ia.addAndUseTREXVersion(version, contracts)
```

| Parameter | Value | Meaning |
|---|---|---|
| `_version` | `{major:1, minor:0, patch:0}` | Version number for this set of implementations |
| `_trexContracts` | `{token, ctr, ir, irs, tir, mc}` | The 6 addresses from Step 1 |

**What happens inside:**
1. Stores the mapping: `version 1.0.0 → these 6 contract addresses`
2. Sets this as the current version
3. Any proxy deployed later will look here to find the actual code to run

---

### STEP 3: Deploy TREXFactory (our modified version)

```
WHO CALLS:    Platform Admin
FUNCTION:     new TREXFactory(ia)
```

| Parameter | Value | Meaning |
|---|---|---|
| `implementationAuthority_` | IA address from Step 2 | The factory will use this IA for all deployments |

**Original had 2 params:** `(ia, idFactory)` — we removed `idFactory`.

**What happens inside the constructor:**
1. Calls `setImplementationAuthority(ia)` which validates all 6 implementations exist
2. Stores the IA address
3. The deployer becomes the owner of the factory

---

### STEP 4: Deploy TREXGateway and approve the deployer

```
WHO CALLS:    Platform Admin
FUNCTION:     new TREXGateway(factory, false)
```

| Parameter | Value | Meaning |
|---|---|---|
| `factory` | Factory address from Step 3 | The gateway will call this factory |
| `publicDeploymentStatus` | `false` | Only approved deployers can create deals (not anyone) |

**Then transfer factory ownership to the gateway:**

```
WHO CALLS:    Platform Admin (factory owner)
FUNCTION:     factory.transferOwnership(gateway)
```

| Parameter | Value | Meaning |
|---|---|---|
| `newOwner` | Gateway address | The gateway now owns the factory — only it can call `deployTREXSuite` |

**Then approve the Platform Admin as a deployer:**

```
WHO CALLS:    Platform Admin (gateway owner)
FUNCTION:     gateway.addDeployer(PLATFORM_ADMIN_SAFE)
```

| Parameter | Value | Meaning |
|---|---|---|
| `deployer` | Platform Admin Safe address | This address can now create deals through the gateway |

---

### STEP 5: Deploy SupplyLimitModule behind a ModuleProxy

```
WHO CALLS:    Platform Admin
FUNCTION:     new SupplyLimitModule()   (the implementation)
              new ModuleProxy(supplyLimitImpl)   (the proxy)
              SupplyLimitModule(proxy).initialize()
```

| What | Why |
|---|---|
| Deploy `SupplyLimitModule` | The implementation code |
| Deploy `ModuleProxy` pointing to it | Upgradeable front for the module |
| Call `initialize()` on the proxy | Sets up the module's internal state |

**Result:** A proxy address that acts as a SupplyLimitModule. This same proxy is reused by every deal.

---

### STEP 6: Deploy MockCashToken and DVDTransferManager

```
WHO CALLS:    Platform Admin
FUNCTION:     new MockCashToken(PLATFORM_ADMIN_SAFE)
              new DVDTransferManager()
```

| Contract | Constructor params | Meaning |
|---|---|---|
| `MockCashToken` | `PLATFORM_ADMIN_SAFE` | Admin can mint test euros. ERC-20 with 6 decimals |
| `DVDTransferManager` | none | Deployer becomes owner. Handles atomic bond-for-cash swaps |

---

### STEP 7: Deploy the deal — `gateway.deployTREXSuite(...)`

This is the **big one**. One call deploys 6 proxy contracts for the deal.

```
WHO CALLS:    Platform Admin Safe (approved deployer)
FUNCTION:     gateway.deployTREXSuite(tokenDetails, claimDetails)
```

**What the Gateway does (line by line):**

```
1. Check: is msg.sender an approved deployer?               → Yes (Step 4)
2. Check: are deployment fees enabled?                       → No (we didn't set any)
3. Generate salt: salt = ownerAddress + tokenName            → unique per deal
4. Call: factory.deployTREXSuite(salt, tokenDetails, claimDetails)
5. Emit: GatewaySuiteDeploymentProcessed event
```

**What the Factory does when `deployTREXSuite` is called:**

```
1.  Validate: salt not already used                          → passes (new deal)
2.  Validate: issuers.length == issuerClaims.length          → passes (both empty)
3.  Validate: max 5 issuers, max 5 topics, max 5 agents     → passes
4.  Validate: max 30 compliance modules                      → passes

5.  Deploy TrustedIssuersRegistryProxy(ia)                   → new TIR proxy
6.  Deploy ClaimTopicsRegistryProxy(ia)                      → new CTR proxy
7.  Deploy ModularComplianceProxy(ia)                        → new MC proxy
8.  Deploy IdentityRegistryStorageProxy(ia)                  → new IRS proxy
        (only if tokenDetails.irs == address(0), which it is)
9.  Deploy IdentityRegistryProxy(ia, tir, ctr, irs)          → new IR proxy
10. Deploy TokenProxy(ia, ir, mc, name, symbol, decimals, ONCHAINID)  → new Token proxy
        (ONCHAINID = address(0) in our design)

11. [REMOVED] if ONCHAINID == 0, create token identity      → WE SKIP THIS

12. Loop: add claim topics to CTR                            → NOTHING (empty list)
13. Loop: add trusted issuers to TIR                         → NOTHING (empty list)
14. Bind IRS to IR: irs.bindIdentityRegistry(ir)             → links storage to registry
15. Add Token as IR agent: ir.addAgent(token)                → token can check whitelist
16. Loop: add IR agents                                      → adds Registrar Safe
17. Loop: add Token agents                                   → adds B&D Safe
18. Loop: add compliance modules + settings                  → adds SupplyLimitModule,
                                                                calls setSupplyLimit(5000)

19. Transfer ownership of Token to owner (Platform Admin)
20. Transfer ownership of IR to owner
21. Transfer ownership of TIR to owner
22. Transfer ownership of CTR to owner
23. Transfer ownership of MC to owner
24. Emit: TREXSuiteDeployed event with all addresses
```

**The `tokenDetails` parameter (what we pass):**

| Field | Value for Deal 51X5RT | Why |
|---|---|---|
| `owner` | Platform Admin Safe address | Will own all 6 contracts |
| `name` | `"ACME Corp / 3.875% Fixed EMTN"` | The bond's display name |
| `symbol` | `"TR-51X5RT-01"` | Tranche ID |
| `decimals` | `0` | Whole bonds only (no fractional) |
| `irs` | `address(0)` | Deploy a new storage (don't reuse) |
| `ONCHAINID` | `address(0)` | No on-chain identity for the token |
| `irAgents` | `[Registrar Safe]` | Who can write the whitelist |
| `tokenAgents` | `[B&D Safe]` | Who can mint/burn/freeze |
| `complianceModules` | `[SupplyLimitModule proxy]` | Cap supply at 5,000 |
| `complianceSettings` | `[abi.encode(setSupplyLimit(5000))]` | Set the limit to 5,000 bonds |

**The `claimDetails` parameter (what we pass):**

| Field | Value | Why |
|---|---|---|
| `claimTopics` | `[]` (empty) | No KYC/AML claims required on-chain |
| `issuers` | `[]` (empty) | No trusted issuers needed |
| `issuerClaims` | `[]` (empty) | Nothing to map |

**This is what makes the whitelist trick work** — empty topics means `isVerified` short-circuits.

---

### STEP 8: Write the whitelist — `identityRegistry.batchRegisterIdentity(...)`

```
WHO CALLS:    Registrar Safe (IR agent, set in Step 7)
FUNCTION:     identityRegistry.batchRegisterIdentity(wallets, identities, countries)
```

| Parameter | Value | Meaning |
|---|---|---|
| `wallets` | `[BND, AURORA, NORTHBRIDGE, MERIDIAN]` | The 4 wallet addresses to whitelist |
| `identities` | `[BND, AURORA, NORTHBRIDGE, MERIDIAN]` | Same addresses! Each wallet's "identity" is itself |
| `countries` | `[0, 0, 0, 0]` | No country data (screens don't provide it) |

**What happens inside (for each wallet):**
1. Calls `IdentityRegistryStorage.addIdentityToStorage(wallet, wallet, 0)`
2. Storage now maps: `wallet → wallet` (identity) and `wallet → 0` (country)
3. Now when `isVerified(wallet)` is called, it finds the wallet in storage → topics list is empty → returns **true**

**To correct the list later (before any swap):**
- Registrar calls `deleteIdentity(wallet)` for wallets that left
- Registrar calls `registerIdentity(newWallet, newWallet, 0)` for new wallets

---

### STEP 9: Mint bonds and unpause — `token.mint(...)` + `token.unpause()`

```
WHO CALLS:    B&D Safe (token agent, set in Step 7)
FUNCTION:     token.mint(BND_SAFE, 5000)
```

| Parameter | Value | Meaning |
|---|---|---|
| `to` | B&D Safe address | Bonds go to B&D's wallet first |
| `amount` | `5000` | Mint exactly 5,000 bonds (the full supply) |

**What happens inside `mint`:**
1. Checks `isVerified(BND_SAFE)` → B&D was registered in Step 8, so **true**
2. Checks compliance: `SupplyLimitModule` allows because 0 + 5000 ≤ 5000
3. 5,000 bonds are minted to B&D's wallet

**IMPORTANT:** Mint fails if B&D is not on the whitelist. That's why Step 8 must come before Step 9.

```
WHO CALLS:    B&D Safe (token agent)
FUNCTION:     token.unpause()
```

**What happens:** Token was paused at creation. Unpausing enables `transferFrom`, which DVD needs.

---

### STEP 10: Fund investors and set allowances

```
WHO CALLS:    Platform Admin (MockCashToken owner)
FUNCTION:     cash.mint(AURORA, 199800000000000)  (repeat for each investor)
```

| Parameter | Value | Meaning |
|---|---|---|
| `to` | Investor wallet | Give them test euros |
| `amount` | `199800000000000` | 199,800 EURd × 10^6 decimals |

**Then each investor approves DVD to spend their cash:**

```
WHO CALLS:    Each investor
FUNCTION:     cash.approve(dvd, amount)
```

| Parameter | Value | Meaning |
|---|---|---|
| `spender` | DVDTransferManager address | DVD can pull cash from investor |
| `amount` | Their cash amount | How much DVD can pull |

**B&D approves DVD to spend their bonds:**

```
WHO CALLS:    B&D Safe
FUNCTION:     token.approve(dvd, 5000)
```

| Parameter | Value | Meaning |
|---|---|---|
| `spender` | DVDTransferManager address | DVD can pull bonds from B&D |
| `amount` | `5000` | All bonds |

---

### STEP 11: B&D offers each trade — `dvd.initiateDVDTransfer(...)`

```
WHO CALLS:    B&D Safe
FUNCTION:     dvd.initiateDVDTransfer(token1, token1Amount, counterpart, token2, token2Amount)
```

**Example — Trade 1 (Aurora gets 2,000 bonds for 199,800,000 EURd):**

| Parameter | Value | Meaning |
|---|---|---|
| `_token1` | Token (bond) address | B&D is offering bonds |
| `_token1Amount` | `2000` | 2,000 bonds |
| `_counterpart` | Aurora's wallet address | The investor receiving the offer |
| `_token2` | MockCashToken address | B&D wants cash in return |
| `_token2Amount` | `199800000000000` | 199,800 EURd (6 decimals) |

**What happens inside:**
1. Checks B&D has ≥ 2000 bonds → yes
2. Checks DVD has allowance for B&D's bonds → yes (Step 10)
3. Checks counterpart is not zero address → yes
4. Checks token2 is valid ERC20 → yes
5. Creates a `transferID` = hash of (nonce, B&D, token, 2000, Aurora, cash, cashAmount)
6. Stores both legs:
   - `token1ToDeliver[transferID]` = {B&D, bondToken, 2000}
   - `token2ToDeliver[transferID]` = {Aurora, cashToken, 199800000000000}
7. Emits `DVDTransferInitiated` event with the `transferID`
8. Increments `txNonce`

**Repeat for each trade** (3 trades total for Deal 51X5RT).

---

### STEP 12: Investor accepts — `dvd.takeDVDTransfer(...)`

```
WHO CALLS:    Investor (e.g. Aurora) OR a token agent (B&D Safe)
FUNCTION:     dvd.takeDVDTransfer(transferID)
```

| Parameter | Value | Meaning |
|---|---|---|
| `_transferID` | The ID from Step 11's event | Which trade to execute |

**What happens inside (the atomic swap):**

```
1.  Load both legs from storage
2.  Check: transferID exists?                → yes
3.  Check: caller is the counterpart (Aurora)
    OR a TREX agent?                         → yes
4.  Check: Aurora has enough cash?           → yes
5.  Check: DVD has allowance for Aurora's cash? → yes

6.  BOND LEG: token.transferFrom(B&D → Aurora, 2000 bonds)
      Inside transferFrom:
      a. Is token paused?                    → no (unpaused in Step 9)
      b. Is B&D frozen?                      → no
      c. Is Aurora frozen?                   → no
      d. Does B&D have enough balance?       → yes (5000 bonds)
      e. isVerified(Aurora)?                 → yes (whitelisted in Step 8)
      f. Compliance check (SupplyLimitModule)? → passes (supply unchanged)
      g. Transfer 2000 bonds from B&D to Aurora ✓

7.  CASH LEG: cash.transferFrom(Aurora → B&D, 199800000000000 EURd)
      Inside transferFrom:
      a. Standard ERC20 transfer             → succeeds ✓

8.  Delete both legs from storage
9.  Emit DVDTransferExecuted event

IF STEP 6 FAILS (e.g. Aurora not on whitelist):
   → The entire transaction reverts
   → Cash doesn't move either
   → Nothing changes — "both legs or nothing"
```

---

## Complete Call Chain Diagram

```
Platform Admin                    Gateway                   Factory
     │                              │                         │
     │  deployTREXSuite             │                         │
     │  (tokenDetails,              │                         │
     │   claimDetails)              │                         │
     │─────────────────────────────▶│                         │
     │                              │  1. Check deployer      │
     │                              │  2. Generate salt       │
     │                              │  3. deployTREXSuite     │
     │                              │────────────────────────▶│
     │                              │                         │  4. Deploy TIR proxy
     │                              │                         │  5. Deploy CTR proxy
     │                              │                         │  6. Deploy MC proxy
     │                              │                         │  7. Deploy IRS proxy
     │                              │                         │  8. Deploy IR proxy
     │                              │                         │  9. Deploy Token proxy
     │                              │                         │  10. Skip ONCHAINID ←(our change)
     │                              │                         │  11. Add claim topics (none)
     │                              │                         │  12. Add trusted issuers (none)
     │                              │                         │  13. Bind IRS ↔ IR
     │                              │                         │  14. Add agents (IR + Token)
     │                              │                         │  15. Add compliance modules
     │                              │                         │  16. Transfer ownership
     │                              │                         │  17. Emit TREXSuiteDeployed
     │                              │◀────────────────────────│
     │                              │  4. Emit GatewaySuite   │
     │◀─────────────────────────────│     DeploymentProcessed │
     │                              │                         │
     │  Done! 6 new proxies live    │                         │
```

```
Registrar             IdentityRegistry         IdentityRegistryStorage
    │                        │                          │
    │  batchRegisterIdentity │                          │
    │  (wallets, wallets, 0s)│                          │
    │───────────────────────▶│                          │
    │                        │  addIdentityToStorage    │
    │                        │  (wallet, wallet, 0)     │
    │                        │─────────────────────────▶│  Stores: wallet → wallet
    │                        │  (repeat for each)       │
    │                        │◀─────────────────────────│
    │◀───────────────────────│                          │
```

```
B&D Safe              Token                 SupplyLimitModule
    │                   │                          │
    │  mint(B&D, 5000)  │                          │
    │──────────────────▶│                          │
    │                   │  isVerified(B&D)?         │
    │                   │──▶ IR ──▶ IRS: yes       │
    │                   │  canTransfer?             │
    │                   │─────────────────────────▶│  0 + 5000 ≤ 5000? ✓
    │                   │◀─────────────────────────│
    │                   │  mint 5000 to B&D ✓      │
    │◀──────────────────│                          │
    │                   │                          │
    │  unpause()        │                          │
    │──────────────────▶│  token is now live        │
```

```
B&D Safe             DVDTransferManager            Token           MockCashToken
    │                        │                       │                   │
    │  initiateDVDTransfer   │                       │                   │
    │  (token, 2000, Aurora, │                       │                   │
    │   cash, cashAmount)    │                       │                   │
    │───────────────────────▶│  Store offer           │                   │
    │                        │  Emit transferID       │                   │
    │◀───────────────────────│                       │                   │

Aurora                DVDTransferManager            Token           MockCashToken
    │                        │                       │                   │
    │  takeDVDTransfer       │                       │                   │
    │  (transferID)          │                       │                   │
    │───────────────────────▶│                       │                   │
    │                        │  BOND LEG:            │                   │
    │                        │  transferFrom(B&D,    │                   │
    │                        │    Aurora, 2000)      │                   │
    │                        │──────────────────────▶│                   │
    │                        │                       │ isVerified(Aurora)?│
    │                        │                       │ → yes (whitelisted)│
    │                        │                       │ compliance? → ok  │
    │                        │                       │ move 2000 bonds ✓ │
    │                        │◀──────────────────────│                   │
    │                        │                       │                   │
    │                        │  CASH LEG:            │                   │
    │                        │  transferFrom(Aurora, │                   │
    │                        │    B&D, cashAmount)   │                   │
    │                        │──────────────────────────────────────────▶│
    │                        │                       │                   │ move cash ✓
    │                        │◀──────────────────────────────────────────│
    │                        │                       │                   │
    │                        │  Delete transfer      │                   │
    │                        │  Emit Executed         │                   │
    │◀───────────────────────│                       │                   │
    │  Aurora has 2000 bonds │                       │                   │
    │  B&D has the cash      │                       │                   │
```
