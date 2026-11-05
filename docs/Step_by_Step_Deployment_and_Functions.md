# SCO Bond — Step-by-Step Deployment & Function Reference

Every smart contract to deploy, every function to call, in exact order.
Each step includes the function signature, parameters with context, and the use case.

---

## Roles (wallet addresses you need before starting)

| Role | Who | What they do |
|---|---|---|
| **Platform Admin** | The deployer wallet | Deploys all contracts, owns the platform, creates deals |
| **Registrar** | IR Agent | Whitelists investor wallets (adds/removes from identity registry) |
| **B&D Agent** | Token Agent | Mints bonds, pauses/unpauses token, initiates DVD transfers |
| **Investors** | End users | Receive bonds, provide cash, execute DVD swaps |

---

## PHASE A: Platform Setup (deploy once, shared by all deals)

---

### Step 1: Deploy 6 Implementation Contracts

These are master copies of code. They are never called directly — proxies point to them.

**1a. Deploy Token implementation**

```
Contract: Token.sol
Constructor: none (implementations are not initialized)
```

- **Use case:** Master copy of the bond token logic (transfer, mint, burn, freeze, pause).
- **Result:** Save the deployed address as `tokenImpl`.

**1b. Deploy IdentityRegistry implementation**

```
Contract: IdentityRegistry.sol
Constructor: none
```

- **Use case:** Master copy of the whitelist logic (register/remove wallets, check `isVerified`).
- **Result:** Save as `irImpl`.

**1c. Deploy IdentityRegistryStorage implementation**

```
Contract: IdentityRegistryStorage.sol
Constructor: none
```

- **Use case:** Master copy of the filing cabinet (stores wallet-to-identity mappings).
- **Result:** Save as `irsImpl`.

**1d. Deploy ClaimTopicsRegistry implementation**

```
Contract: ClaimTopicsRegistry.sol
Constructor: none
```

- **Use case:** Master copy of required claim topics list (empty in our design = no claims needed).
- **Result:** Save as `ctrImpl`.

**1e. Deploy TrustedIssuersRegistry implementation**

```
Contract: TrustedIssuersRegistry.sol
Constructor: none
```

- **Use case:** Master copy of trusted issuers list (empty in our design = no issuers needed).
- **Result:** Save as `tirImpl`.

**1f. Deploy ModularCompliance implementation**

```
Contract: ModularCompliance.sol
Constructor: none
```

- **Use case:** Master copy of the compliance rule engine (checks modules before allowing transfers).
- **Result:** Save as `mcImpl`.

> **Note:** Steps 1a–1f can be deployed in any order. They have no dependencies on each other.

---

### Step 2: Deploy TREXImplementationAuthority (IA)

```
Contract: TREXImplementationAuthority.sol
```

**Constructor:**

```solidity
constructor(bool referenceStatus, address trexFactory, address iaFactory)
```

| Parameter | Type | Value to pass | Why |
|---|---|---|---|
| `referenceStatus` | `bool` | `true` | This is the main/reference IA (not an auxiliary copy) |
| `trexFactory` | `address` | `address(0)` | Factory doesn't exist yet — will be set later via `setTREXFactory` |
| `iaFactory` | `address` | `address(0)` | Not needed for PoV — IAFactory is optional |

- **Use case:** The version registry that stores where the 6 implementation contracts live. All proxies ask the IA to find their code.
- **Result:** Save as `ia`.

---

### Step 3: Register the 6 implementations in the IA

**Function to call:**

```solidity
ia.addAndUseTREXVersion(Version _version, TREXContracts _trex)
```

| Parameter | Type | Value to pass | Why |
|---|---|---|---|
| `_version.major` | `uint8` | `4` | Version label (follows T-REX convention) |
| `_version.minor` | `uint8` | `0` | Minor version |
| `_version.patch` | `uint8` | `0` | Patch version |
| `_trex.tokenImplementation` | `address` | `tokenImpl` | Address from Step 1a |
| `_trex.ctrImplementation` | `address` | `ctrImpl` | Address from Step 1d |
| `_trex.irImplementation` | `address` | `irImpl` | Address from Step 1b |
| `_trex.irsImplementation` | `address` | `irsImpl` | Address from Step 1c |
| `_trex.tirImplementation` | `address` | `tirImpl` | Address from Step 1e |
| `_trex.mcImplementation` | `address` | `mcImpl` | Address from Step 1f |

- **Use case:** Registers all 6 implementation addresses under version `4.0.0` AND sets it as the active version. After this, proxies can look up their code.
- **Caller:** Platform Admin (owner of IA)

---

### Step 4: Deploy TREXFactory

```
Contract: TREXFactory.sol (our modified version — no ONCHAINID)
```

**Constructor:**

```solidity
constructor(address implementationAuthority_)
```

| Parameter | Type | Value to pass | Why |
|---|---|---|---|
| `implementationAuthority_` | `address` | `ia` | The IA from Step 2. Factory uses it to know which implementations to point proxies at |

- **Use case:** The builder — creates a full suite of 6 proxy contracts per deal in one transaction using CREATE2.
- **Validation:** The constructor checks that IA has all 6 implementations set (non-zero). If Step 3 was skipped, this will revert.
- **Result:** Save as `factory`.

---

### Step 5: Link the Factory back to the IA

**Function to call:**

```solidity
ia.setTREXFactory(address trexFactory)
```

| Parameter | Type | Value to pass | Why |
|---|---|---|---|
| `trexFactory` | `address` | `factory` | We passed `address(0)` in Step 2 because Factory didn't exist yet. Now we link them. |

- **Use case:** The IA needs to know its Factory address so `getReferenceContract()` works and so the IA can validate that it's the reference IA for this Factory.
- **Caller:** Platform Admin (owner of IA)

---

### Step 6: Deploy TREXGateway

```
Contract: TREXGateway.sol
```

**Constructor:**

```solidity
constructor(address factory, bool publicDeploymentStatus)
```

| Parameter | Type | Value to pass | Why |
|---|---|---|---|
| `factory` | `address` | `factory` | The TREXFactory from Step 4 |
| `publicDeploymentStatus` | `bool` | `false` | Only approved deployers can create deals (not open to public) |

- **Use case:** The security guard / front door. Controls WHO can create deals through the Factory.
- **Result:** Save as `gateway`.

---

### Step 7: Transfer Factory ownership to Gateway

**Function to call:**

```solidity
factory.transferOwnership(address newOwner)
```

| Parameter | Type | Value to pass | Why |
|---|---|---|---|
| `newOwner` | `address` | `gateway` | Factory's `deployTREXSuite` is `onlyOwner`. Gateway needs to own Factory to call it. |

- **Use case:** After this, only the Gateway can trigger deal deployments on the Factory. Platform Admin goes through the Gateway instead of calling Factory directly.
- **Caller:** Platform Admin (current owner of Factory)

---

### Step 8: Add Platform Admin as approved deployer on Gateway

**Function to call:**

```solidity
gateway.addDeployer(address deployer)
```

| Parameter | Type | Value to pass | Why |
|---|---|---|---|
| `deployer` | `address` | `platformAdmin` | The wallet that will create deals |

- **Use case:** Since `publicDeploymentStatus` is `false`, only addresses in the deployer whitelist can call `deployTREXSuite` on the Gateway. This adds Platform Admin to that whitelist.
- **Caller:** Platform Admin (owner of Gateway)

---

### Step 9: Deploy SupplyLimitModule

```
Contract: SupplyLimitModule.sol
```

**Constructor:** none (it's an upgradeable contract, uses `initialize` instead)

**Function to call after deployment:**

```solidity
supplyLimitModule.initialize()
```

| Parameter | None |
|---|---|

- **Use case:** The compliance module that caps the total supply of bonds. For deal 51X5RT, the limit is 5,000 bonds. This is the implementation — it needs a proxy in front of it.
- **Result:** Save as `supplyLimitImpl`.

---

### Step 10: Deploy ModuleProxy for SupplyLimitModule

```
Contract: ModuleProxy.sol
```

**Constructor:**

```solidity
constructor(address implementation, bytes memory _data)
```

| Parameter | Type | Value to pass | Why |
|---|---|---|---|
| `implementation` | `address` | `supplyLimitImpl` | The SupplyLimitModule from Step 9 |
| `_data` | `bytes` | `abi.encodeWithSignature("initialize()")` | Calls `initialize()` on the module through the proxy during deployment |

- **Use case:** ERC1967 proxy that wraps the SupplyLimitModule. This is the address you'll pass to `deployTREXSuite` as a compliance module.
- **Result:** Save as `supplyLimitProxy`.

---

### Step 11: Deploy MockCashToken

```
Contract: MockCashToken.sol
```

**Constructor:**

```solidity
constructor()  // inherits ERC20("Euro Digital", "EURd")
```

No parameters needed.

- **Use case:** Test ERC-20 token simulating digital Euro (EURd) with 6 decimals. Used as the cash leg in DVD (bond-for-cash) swaps.
- **Result:** Save as `cashToken`.

---

### Step 12: Deploy DVDTransferManager

```
Contract: DVDTransferManager.sol
```

**Constructor:**

```solidity
constructor()  // sets txNonce = 0
```

No parameters needed.

- **Use case:** The atomic swap engine. Bonds and cash move in one transaction, or neither moves. Used for settlement between B&D agent and investors.
- **Result:** Save as `dvd`.

**How DVD settlement works (simplified):**

```
  B&D Agent (has bonds)                    Investor (has EURd cash)
       |                                        |
       |   "I'll give you 100 bonds             |
       |    if you give me 100 EURd"            |
       |  -----> initiateDVDTransfer() ------>  |
       |                                        |
       |         (offer is pending)             |
       |                                        |
       |                    "Deal, here's       |
       |                     my 100 EURd"       |
       |  <----- takeDVDTransfer() <----------  |
       |                                        |
       |     ATOMIC SWAP (one transaction):     |
       |     100 bonds  ──> Investor            |
       |     100 EURd   ──> B&D Agent           |
       |                                        |
       |  If EITHER side fails (not enough      |
       |  balance, not whitelisted, compliance   |
       |  rejected) → NOTHING moves.            |
```

**In simple terms:**
- **B&D Agent provides:** Bonds (the security token created in Step 13)
- **Investor provides:** EURd cash (the MockCashToken from Step 11)
- **DVD contract ensures:** Both sides happen together or not at all — no one can cheat
- **Why atomic?** Without DVD, you'd need two separate transfers (send bonds, then send cash). If one side sends but the other doesn't, someone loses. DVD eliminates that risk.

---

## PHASE B: Create a Deal (one transaction)

---

### Step 13: Deploy a TREX Suite through the Gateway

**Function to call:**

```solidity
gateway.deployTREXSuite(
    ITREXFactory.TokenDetails memory _tokenDetails,
    ITREXFactory.ClaimDetails memory _claimDetails
)
```

#### TokenDetails struct:

| Field | Type | Value for deal 51X5RT | Why |
|---|---|---|---|
| `owner` | `address` | `platformAdmin` | Gets ownership of all 6 deal contracts after deployment |
| `name` | `string` | `"SCO Bond 51X5RT"` | Human-readable token name |
| `symbol` | `string` | `"SCO51X"` | Ticker symbol |
| `decimals` | `uint8` | `0` | Whole bonds only, no fractions |
| `irs` | `address` | `address(0)` | Pass zero to deploy a new IdentityRegistryStorage for this deal. Pass an existing IRS address to share storage across deals. |
| `ONCHAINID` | `address` | `address(0)` | No ONCHAINID (our design). Token's identity stays as zero address. |
| `irAgents` | `address[]` | `[registrar]` | Wallets that can add/remove investors from the whitelist. Max 5 at deployment. |
| `tokenAgents` | `address[]` | `[bndAgent]` | Wallets that can mint, burn, pause, unpause, freeze tokens. Max 5 at deployment. |
| `complianceModules` | `address[]` | `[supplyLimitProxy]` | Compliance modules to plug in. Max 30 at deployment. |
| `complianceSettings` | `bytes[]` | `[abi.encodeWithSignature("setSupplyLimit(uint256)", 5000)]` | Encoded function calls to configure each module. This sets the supply cap to 5,000 bonds. |

#### ClaimDetails struct:

| Field | Type | Value | Why |
|---|---|---|---|
| `claimTopics` | `uint256[]` | `[]` (empty) | No claim topics required. This is what makes `isVerified()` short-circuit to a pure whitelist. |
| `issuers` | `address[]` | `[]` (empty) | No trusted issuers needed |
| `issuerClaims` | `uint256[][]` | `[]` (empty) | No issuer-to-claim mappings |

- **Use case:** Creates 6 proxy contracts in one transaction: Token proxy, IR proxy, IRS proxy, CTR proxy, TIR proxy, MC proxy. All are wired together and ownership is transferred to `_tokenDetails.owner`.
- **Caller:** Platform Admin (must be an approved deployer on Gateway)
- **Salt:** Auto-generated by Gateway as `hex(owner) + tokenName`
- **Emits:** `TREXSuiteDeployed(token, ir, irs, tir, ctr, mc, salt)` — this gives you all 6 deployed proxy addresses.

> **Save all 6 proxy addresses from the event:** `tokenProxy`, `irProxy`, `irsProxy`, `tirProxy`, `ctrProxy`, `mcProxy`

---

## PHASE C: Run the Deal

---

### Step 14: Whitelist investor wallets

**Function to call:**

```solidity
identityRegistry.batchRegisterIdentity(
    address[] calldata _userAddresses,
    IIdentity[] calldata _identities,
    uint16[] calldata _countries
)
```

| Parameter | Type | Value | Why |
|---|---|---|---|
| `_userAddresses` | `address[]` | `[investor1, investor2, investor3, investor4]` | The wallet addresses to whitelist |
| `_identities` | `IIdentity[]` | `[investor1, investor2, investor3, investor4]` | In our design, each wallet's "identity" is itself (wallet address). Standard T-REX uses ONCHAINID here. |
| `_countries` | `uint16[]` | `[0, 0, 0, 0]` | Country code. We pass 0 for all since we don't use country-based restrictions. |

- **Use case:** Registers wallets in the IdentityRegistryStorage so they pass the `isVerified()` check. Without this, wallets cannot receive bonds (mint and transfer will revert).
- **Caller:** Registrar (IR Agent)
- **Also whitelist B&D agent's wallet** if they will hold bonds (e.g., the BND_SAFE address).

**To remove a wallet from the whitelist later:**

```solidity
identityRegistry.deleteIdentity(address _userAddress)
```

| Parameter | Type | Why |
|---|---|---|
| `_userAddress` | `address` | The wallet to de-whitelist. After this, the wallet can no longer receive bonds. |

---

### Step 15: Mint bonds

**Function to call:**

```solidity
token.mint(address _to, uint256 _amount)
```

| Parameter | Type | Value | Why |
|---|---|---|---|
| `_to` | `address` | `bndSafe` | The B&D agent's safe/wallet that will hold bonds before distributing |
| `_amount` | `uint256` | `5000` | Total bonds to issue for this deal (matches supply limit) |

- **Use case:** Creates 5,000 bond tokens in the B&D safe. The SupplyLimitModule prevents minting more than 5,000.
- **Caller:** B&D Agent (Token Agent)
- **Pre-requisite:** `bndSafe` must be whitelisted (Step 14). Mint calls `isVerified(_to)` internally — it reverts if the recipient is not registered.

---

### Step 16: Unpause the token

**Function to call:**

```solidity
token.unpause()
```

No parameters.

- **Use case:** Tokens are paused by default after deployment. While paused, `transfer` and `transferFrom` are blocked. Unpausing enables trading and DVD swaps.
- **Caller:** B&D Agent (Token Agent)

---

### Step 17: Mint test cash (MockCashToken) to investors

**Function to call:**

```solidity
cashToken.mint(address _to, uint256 _amount)
```

| Parameter | Type | Value | Why |
|---|---|---|---|
| `_to` | `address` | `investor1` | The investor wallet to fund |
| `_amount` | `uint256` | `1000000000` (= 1,000 EURd with 6 decimals) | Amount of test Euros. Example: 1,000 EURd = 1,000 * 10^6 = 1,000,000,000 |

- **Use case:** Give each investor enough test EURd to pay for their bond allocation.
- **Caller:** Platform Admin (owner of MockCashToken)
- **Repeat** for each investor wallet.

---

### Step 18: Investors approve DVDTransferManager to spend their cash

**Function to call (by each investor):**

```solidity
cashToken.approve(address _spender, uint256 _amount)
```

| Parameter | Type | Value | Why |
|---|---|---|---|
| `_spender` | `address` | `dvd` | The DVDTransferManager contract address |
| `_amount` | `uint256` | The cash amount for the swap | Allows DVD contract to pull cash from investor's wallet during atomic swap |

- **Use case:** ERC-20 approval. DVD contract needs allowance to move cash tokens on behalf of the investor during `takeDVDTransfer`.
- **Caller:** Each investor (from their own wallet)

---

### Step 19: B&D agent approves DVDTransferManager to spend bonds

**Function to call:**

```solidity
token.approve(address _spender, uint256 _amount)
```

| Parameter | Type | Value | Why |
|---|---|---|---|
| `_spender` | `address` | `dvd` | The DVDTransferManager contract address |
| `_amount` | `uint256` | `5000` | Total bonds to be distributed via DVD swaps |

- **Use case:** Allows DVD contract to pull bond tokens from B&D safe during atomic swap execution.
- **Caller:** B&D Agent (from the BND_SAFE wallet)

---

### Step 20: B&D agent initiates DVD transfers (one per investor)

**Function to call:**

```solidity
dvd.initiateDVDTransfer(
    address _token1,
    uint256 _token1Amount,
    address _counterpart,
    address _token2,
    uint256 _token2Amount
)
```

| Parameter | Type | Value (example) | Why |
|---|---|---|---|
| `_token1` | `address` | `tokenProxy` | The bond token (what B&D is offering) |
| `_token1Amount` | `uint256` | `100` | Number of bonds for this investor |
| `_counterpart` | `address` | `investor1` | The investor who will receive bonds and pay cash |
| `_token2` | `address` | `cashToken` | The EURd token (what investor will pay) |
| `_token2Amount` | `uint256` | `100000000` (= 100 EURd with 6 decimals) | Cash amount the investor must provide |

- **Use case:** Creates a pending atomic swap offer: "I'll give you 100 bonds if you give me 100 EURd". Nothing moves yet — just records the offer.
- **Caller:** B&D Agent (from BND_SAFE)
- **Emits:** `DVDTransferInitiated(transferID, maker, token1, amount1, taker, token2, amount2)` — save the `transferID` for Step 21.
- **Repeat** for each investor with their allocation.

---

### Step 21: Investors execute DVD transfers (atomic swap)

**Function to call:**

```solidity
dvd.takeDVDTransfer(bytes32 _transferID)
```

| Parameter | Type | Value | Why |
|---|---|---|---|
| `_transferID` | `bytes32` | From Step 20 event | The unique ID of the pending DVD transfer to execute |

- **Use case:** The atomic swap happens here. In one transaction:
  - Bonds move from B&D safe to investor
  - Cash moves from investor to B&D safe
  - If either leg fails (not enough balance, not whitelisted, compliance fails), **nothing moves**
- **Caller:** The investor (counterpart) OR a TREX agent
- **Pre-requisites:**
  - Investor must have enough cash balance
  - Investor must have approved DVD contract (Step 18)
  - B&D must have approved DVD contract (Step 19)
  - Investor must be whitelisted (Step 14)
  - Token must be unpaused (Step 16)

---

### Step 22 (optional): Cancel a DVD transfer

**Function to call:**

```solidity
dvd.cancelDVDTransfer(bytes32 _transferID)
```

| Parameter | Type | Value | Why |
|---|---|---|---|
| `_transferID` | `bytes32` | The transfer to cancel | Removes the pending offer. No tokens move. |

- **Use case:** Cancel a pending swap if the deal terms change or investor backs out.
- **Caller:** Either the maker (B&D), the taker (investor), the DVD owner, or a TREX agent.

---

## Summary: Complete Function Call Sequence

```
PHASE A — Platform Setup
  1a–1f.  Deploy 6 implementations                          (no function calls, just deploy)
  2.      Deploy IA(true, address(0), address(0))            (constructor)
  3.      ia.addAndUseTREXVersion(version, trexContracts)     (register implementations)
  4.      Deploy Factory(ia)                                  (constructor)
  5.      ia.setTREXFactory(factory)                          (link IA ↔ Factory)
  6.      Deploy Gateway(factory, false)                      (constructor)
  7.      factory.transferOwnership(gateway)                  (Gateway owns Factory)
  8.      gateway.addDeployer(platformAdmin)                  (whitelist deployer)
  9.      Deploy SupplyLimitModule + initialize()             (deploy + init)
  10.     Deploy ModuleProxy(supplyLimitImpl, initData)       (proxy for module)
  11.     Deploy MockCashToken()                              (test EURd)
  12.     Deploy DVDTransferManager()                         (atomic swap engine)

PHASE B — Create Deal
  13.     gateway.deployTREXSuite(tokenDetails, claimDetails) (creates 6 proxies)

PHASE C — Run Deal
  14.     ir.batchRegisterIdentity(wallets, wallets, [0...])  (whitelist investors)
  15.     token.mint(bndSafe, 5000)                           (issue bonds)
  16.     token.unpause()                                     (enable transfers)
  17.     cashToken.mint(investor, amount)                     (fund investors)  [repeat per investor]
  18.     cashToken.approve(dvd, amount)                       (investor approves) [repeat per investor]
  19.     token.approve(dvd, 5000)                             (B&D approves)
  20.     dvd.initiateDVDTransfer(token, amt, investor, cash, cashAmt)  [repeat per investor]
  21.     dvd.takeDVDTransfer(transferID)                      (atomic swap)  [repeat per investor]
```

---

## Quick Reference: Who Calls What

| Function | Caller | Contract |
|---|---|---|
| `addAndUseTREXVersion` | Platform Admin | IA |
| `setTREXFactory` | Platform Admin | IA |
| `transferOwnership` | Platform Admin | Factory |
| `addDeployer` | Platform Admin | Gateway |
| `deployTREXSuite` | Platform Admin | Gateway |
| `batchRegisterIdentity` | Registrar (IR Agent) | IdentityRegistry proxy |
| `mint` (bonds) | B&D Agent (Token Agent) | Token proxy |
| `unpause` | B&D Agent (Token Agent) | Token proxy |
| `mint` (cash) | Platform Admin | MockCashToken |
| `approve` (cash) | Each investor | MockCashToken |
| `approve` (bonds) | B&D Agent | Token proxy |
| `initiateDVDTransfer` | B&D Agent | DVDTransferManager |
| `takeDVDTransfer` | Each investor | DVDTransferManager |
