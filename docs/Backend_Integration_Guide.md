# Backend Integration Guide — Smart Contract Functions & Events

Complete reference for the Java/Spring Boot backend: every function the backend must call and every event it must listen to, organized by contract and lifecycle phase.

---

## Role Summary

| Role | Wallet | What It Does |
|---|---|---|
| **Deployer** | Platform deployer | Deploys platform infra (IA, Factory, Gateway, modules) |
| **Platform Admin** | Owner of TREX suite | Owns Token, IR, CTR, TIR, MC — can pause, set compliance |
| **Registrar** | IR Agent | Whitelists/removes investors on IdentityRegistry |
| **B&D Agent** | Token Agent | Mints, burns, freezes, initiates & settles DVD transfers |
| **Investor** | End user | Holds bonds, approves ERC-20 allowance — never calls DVD directly |

---

## Phase 1: Platform Deployment (One-Time Setup)

### 1.1 TREXImplementationAuthority

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Register version | `addAndUseTREXVersion(Version, Implementations)` | Deployer (owner) | `Version{major,minor,patch}`, `Implementations{tokenImpl,ctrImpl,irImpl,irsImpl,tirImpl,mcImpl}` |

**Events to store:** None critical — deployment is a one-time operation.

### 1.2 TREXGateway

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Deploy TREX suite | `deployTREXSuite(TokenDetails, ClaimDetails)` | Deployer (approved) | See structs below |
| Add deployer | `addDeployer(address)` | Owner | Deployer wallet address |
| Remove deployer | `removeDeployer(address)` | Owner | Deployer wallet address |
| Toggle public deploy | `setPublicDeploymentStatus(bool)` | Owner | `true`/`false` |
| Check deployer | `isDeployer(address)` | Anyone (view) | Address to check |

**TokenDetails struct:**
```
{
  owner: address,           // platformAdmin
  name: string,             // "ACME Corp / 3.875% Fixed EMTN"
  symbol: string,           // "TR-51X5RT-01"
  decimals: uint8,          // 0 (whole bonds)
  irs: address,             // ZeroAddress = deploy new IRS
  ONCHAINID: address,       // ZeroAddress (removed)
  irAgents: address[],      // [registrar]
  tokenAgents: address[],   // [bndSafe]
  complianceModules: address[], // [supplyLimitModuleProxy]
  complianceSettings: bytes[]   // [abi.encode(setSupplyLimit(5000))]
}
```

**ClaimDetails struct:**
```
{
  claimTopics: uint256[],   // [] (empty for PoV)
  issuers: address[],       // [] (empty for PoV)
  issuerClaims: uint256[][] // [] (empty for PoV)
}
```

**Events to listen:**

| Event | Contract | Signature | When | DB Table |
|---|---|---|---|---|
| `TREXSuiteDeployed` | TREXFactory | `(address indexed token, address ir, address irs, address tir, address ctr, address mc, string indexed salt)` | After `deployTREXSuite` | `deal_deployments` |
| `GatewaySuiteDeploymentProcessed` | TREXGateway | `(address indexed requester, address intendedOwner, uint256 feeApplied)` | After `deployTREXSuite` | `deal_deployments` |
| `DeployerAdded` | TREXGateway | `(address indexed deployer)` | After `addDeployer` | `audit_log` |
| `DeployerRemoved` | TREXGateway | `(address indexed deployer)` | After `removeDeployer` | `audit_log` |

---

## Phase 2: Investor Whitelisting

### 2.1 IdentityRegistry (IR)

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Whitelist investor | `registerIdentity(address, IIdentity, uint16)` | Registrar (IR Agent) | `_userAddress`, `_identity` (ZeroAddress trick), `_country` (ISO 3166-1 numeric) |
| Batch whitelist | `batchRegisterIdentity(address[], IIdentity[], uint16[])` | Registrar (IR Agent) | Arrays of addresses, identities, countries |
| Remove investor | `deleteIdentity(address)` | Registrar (IR Agent) | Investor wallet address |
| Update country | `updateCountry(address, uint16)` | Registrar (IR Agent) | Investor wallet, new country code |
| Update identity | `updateIdentity(address, IIdentity)` | Registrar (IR Agent) | Investor wallet, new identity address |
| Check whitelisted | `contains(address)` | Anyone (view) | Wallet address |
| Check verified | `isVerified(address)` | Anyone (view) | Wallet address |
| Get identity | `identity(address)` | Anyone (view) | Wallet address |
| Get country | `investorCountry(address)` | Anyone (view) | Wallet address |

**Events to listen:**

| Event | Signature | When | DB Table |
|---|---|---|---|
| `IdentityRegistered` | `(address indexed investorAddress, IIdentity indexed identity)` | After `registerIdentity` | `whitelist_entries` |
| `IdentityRemoved` | `(address indexed investorAddress, IIdentity indexed identity)` | After `deleteIdentity` | `whitelist_entries` |
| `IdentityUpdated` | `(IIdentity indexed oldIdentity, IIdentity indexed newIdentity)` | After `updateIdentity` | `whitelist_entries` |
| `CountryUpdated` | `(address indexed investorAddress, uint16 indexed country)` | After `updateCountry` | `whitelist_entries` |

### 2.2 IdentityRegistryStorage (IRS)

Backend does NOT call IRS directly — IR delegates to it. But listen to these events for complete audit trail:

| Event | Signature | When | DB Table |
|---|---|---|---|
| `IdentityStored` | `(address indexed investorAddress, IIdentity indexed identity)` | When IR registers identity | `whitelist_entries` |
| `IdentityUnstored` | `(address indexed investorAddress, IIdentity indexed identity)` | When IR deletes identity | `whitelist_entries` |
| `IdentityModified` | `(IIdentity indexed oldIdentity, IIdentity indexed newIdentity)` | When IR updates identity | `whitelist_entries` |
| `CountryModified` | `(address indexed investorAddress, uint16 indexed country)` | When IR updates country | `whitelist_entries` |
| `IdentityRegistryBound` | `(address indexed identityRegistry)` | When IRS is linked to IR | `audit_log` |
| `IdentityRegistryUnbound` | `(address indexed identityRegistry)` | When IRS is unlinked | `audit_log` |

**IRS View Functions (for backend queries):**

| Function | Returns | Use |
|---|---|---|
| `storedIdentity(address)` | `IIdentity` | Get investor's onchain identity |
| `storedInvestorCountry(address)` | `uint16` | Get investor's country code |
| `linkedIdentityRegistries()` | `address[]` | List all IRs sharing this storage |

---

## Phase 3: Token Operations (Mint, Burn, Transfer, Freeze)

### 3.1 Token (ERC-3643 Security Token)

**Agent-only functions (B&D Agent calls):**

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Unpause token | `unpause()` | Token Agent | — |
| Pause token | `pause()` | Token Agent | — |
| Mint bonds | `mint(address, uint256)` | Token Agent | `_to` (investor), `_amount` |
| Batch mint | `batchMint(address[], uint256[])` | Token Agent | Arrays |
| Burn bonds | `burn(address, uint256)` | Token Agent | `_userAddress`, `_amount` |
| Batch burn | `batchBurn(address[], uint256[])` | Token Agent | Arrays |
| Force transfer | `forcedTransfer(address, address, uint256)` | Token Agent | `_from`, `_to`, `_amount` |
| Batch force transfer | `batchForcedTransfer(address[], address[], uint256[])` | Token Agent | Arrays |
| Freeze wallet | `setAddressFrozen(address, bool)` | Token Agent | `_userAddress`, `_freeze` |
| Batch freeze | `batchSetAddressFrozen(address[], bool[])` | Token Agent | Arrays |
| Freeze tokens (partial) | `freezePartialTokens(address, uint256)` | Token Agent | `_userAddress`, `_amount` |
| Unfreeze tokens (partial) | `unfreezePartialTokens(address, uint256)` | Token Agent | `_userAddress`, `_amount` |
| Batch freeze partial | `batchFreezePartialTokens(address[], uint256[])` | Token Agent | Arrays |
| Batch unfreeze partial | `batchUnfreezePartialTokens(address[], uint256[])` | Token Agent | Arrays |
| Recover lost wallet | `recoveryAddress(address, address, address)` | Token Agent | `_lostWallet`, `_newWallet`, `_investorOnchainID` |

**Owner-only functions (Platform Admin calls):**

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Set token name | `setName(string)` | Owner | New name |
| Set token symbol | `setSymbol(string)` | Owner | New symbol |
| Set onchainID | `setOnchainID(address)` | Owner | Identity address |
| Set IR | `setIdentityRegistry(address)` | Owner | IR contract address |
| Set compliance | `setCompliance(address)` | Owner | MC contract address |

**Investor-callable functions:**

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Transfer bonds | `transfer(address, uint256)` | Investor (token holder) | `_to`, `_amount` |
| Approve allowance | `approve(address, uint256)` | Investor (token holder) | `_spender` (DVD contract), `_amount` |
| Batch transfer | `batchTransfer(address[], uint256[])` | Investor | Arrays |

**View functions (backend queries):**

| Function | Returns | Use |
|---|---|---|
| `balanceOf(address)` | `uint256` | Investor's bond balance |
| `totalSupply()` | `uint256` | Total bonds in circulation |
| `paused()` | `bool` | Is token paused? |
| `isFrozen(address)` | `bool` | Is wallet frozen? |
| `getFrozenTokens(address)` | `uint256` | Partially frozen amount |
| `name()` | `string` | Token name |
| `symbol()` | `string` | Token symbol |
| `decimals()` | `uint8` | Token decimals |
| `identityRegistry()` | `address` | Linked IR address |
| `compliance()` | `address` | Linked MC address |

**Events to listen:**

| Event | Signature | When | DB Table |
|---|---|---|---|
| `Transfer` | `(address indexed from, address indexed to, uint256 value)` | Mint (from=0x0), burn (to=0x0), transfer, forcedTransfer | `token_transfers` |
| `Approval` | `(address indexed owner, address indexed spender, uint256 value)` | `approve()` — investor approves DVD contract | `token_approvals` |
| `Paused` | `(address _userAddress)` | Token paused by agent | `token_state` |
| `Unpaused` | `(address _userAddress)` | Token unpaused by agent | `token_state` |
| `AddressFrozen` | `(address indexed _userAddress, bool indexed _isFrozen, address indexed _owner)` | Wallet frozen/unfrozen | `token_state` |
| `TokensFrozen` | `(address indexed _userAddress, uint256 _amount)` | Partial freeze | `token_state` |
| `TokensUnfrozen` | `(address indexed _userAddress, uint256 _amount)` | Partial unfreeze | `token_state` |
| `RecoverySuccess` | `(address indexed _lostWallet, address indexed _newWallet, address indexed _investorOnchainID)` | Wallet recovery | `token_state` |
| `UpdatedTokenInformation` | `(string indexed _newName, string indexed _newSymbol, uint8 _newDecimals, string _newVersion, address indexed _newOnchainID)` | Name/symbol/ID changed | `audit_log` |
| `IdentityRegistryAdded` | `(address indexed _identityRegistry)` | IR swapped on token | `audit_log` |
| `ComplianceAdded` | `(address indexed _compliance)` | Compliance swapped on token | `audit_log` |

---

## Phase 4: DVD Settlement (Bond-for-Cash Atomic Swap)

### 4.1 Pre-requisite: ERC-20 Approvals

Before DVD settlement, both parties must approve the DVDTransferManager contract:

| Who | Function on Which Token | Purpose |
|---|---|---|
| B&D Agent | `bondToken.approve(dvdManager, bondAmount)` | Allow DVD to pull bonds |
| Investor | `cashToken.approve(dvdManager, cashAmount)` | Allow DVD to pull cash |

### 4.2 DVDTransferManager

**Agent-only functions:**

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Initiate swap | `initiateDVDTransfer(address, uint256, address, address, uint256)` | TREX Agent | `_token1` (what caller gives), `_token1Amount`, `_counterpart` (receiver of token1), `_token2` (what counterpart gives), `_token2Amount` |
| Execute swap | `takeDVDTransfer(bytes32)` | TREX Agent | `_transferID` |

**Cancelable by multiple roles:**

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Cancel swap | `cancelDVDTransfer(bytes32)` | Maker, Taker, DVD Owner, or TREX Agent | `_transferID` |

**Owner/TREX-owner functions:**

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Set fees | `modifyFee(address, address, uint, uint, uint, address, address)` | DVD Owner or TREX token owner | `_token1`, `_token2`, `_fee1`, `_fee2`, `_feeBase`, `_fee1Wallet`, `_fee2Wallet` |

**View functions:**

| Function | Returns | Use |
|---|---|---|
| `token1ToDeliver(bytes32)` | `Delivery{counterpart, token, amount}` | Get maker side of a pending transfer |
| `token2ToDeliver(bytes32)` | `Delivery{counterpart, token, amount}` | Get taker side of a pending transfer |
| `txNonce()` | `uint256` | Current nonce (for calculating next transferID) |
| `calculateTransferID(uint256, address, address, uint256, address, address, uint256)` | `bytes32` | Compute transferID from params |
| `calculateFee(bytes32)` | `TxFees{txFee1, txFee2, fee1Wallet, fee2Wallet}` | Get fees for a pending transfer |
| `isTREX(address)` | `bool` | Check if token is a TREX token |
| `isTREXAgent(address, address)` | `bool` | Check if user is agent of TREX token |

**Events to listen:**

| Event | Signature | When | DB Table |
|---|---|---|---|
| `DVDTransferInitiated` | `(bytes32 indexed transferID, address maker, address indexed token1, uint256 token1Amount, address taker, address indexed token2, uint256 token2Amount)` | After `initiateDVDTransfer` | `dvd_transfers` |
| `DVDTransferExecuted` | `(bytes32 indexed transferID)` | After `takeDVDTransfer` | `dvd_transfers` |
| `DVDTransferCancelled` | `(bytes32 indexed transferID)` | After `cancelDVDTransfer` | `dvd_transfers` |
| `FeeModified` | `(bytes32 indexed parity, address token1, address token2, uint fee1, uint fee2, uint feeBase, address fee1Wallet, address fee2Wallet)` | After `modifyFee` | `audit_log` |

### 4.3 MockCashToken (EURd)

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Mint cash | `mint(address, uint256)` | Owner (deployer) | `_to`, `_amount` |
| Transfer cash | `transfer(address, uint256)` | Token holder | `_to`, `_amount` |
| Approve DVD | `approve(address, uint256)` | Token holder | `_spender`, `_amount` |

**Events:** Standard ERC-20 `Transfer` and `Approval` events.

---

## Phase 5: Compliance & Modules

### 5.1 ModularCompliance (MC)

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Add module | `addModule(address)` | Owner | Module address |
| Remove module | `removeModule(address)` | Owner | Module address |
| Call module function | `callModuleFunction(bytes, address)` | Owner | Encoded calldata, module address |
| Bind token | `bindToken(address)` | Owner | Token address |
| Unbind token | `unbindToken(address)` | Owner | Token address |

**Auto-called by Token (not by backend):**

| Function | Called By | When |
|---|---|---|
| `transferred(address, address, uint256)` | Token contract | On every transfer |
| `created(address, uint256)` | Token contract | On every mint |
| `destroyed(address, uint256)` | Token contract | On every burn |
| `canTransfer(address, address, uint256)` | Token contract (view) | Pre-transfer compliance check |

**View functions:**

| Function | Returns | Use |
|---|---|---|
| `getModules()` | `address[]` | List bound modules |
| `getTokenBound()` | `address` | Token address |
| `isModuleBound(address)` | `bool` | Check if module is active |

**Events to listen:**

| Event | Signature | When | DB Table |
|---|---|---|---|
| `ModuleAdded` | `(address indexed _module)` | Module bound | `compliance_events` |
| `ModuleRemoved` | `(address indexed _module)` | Module unbound | `compliance_events` |
| `TokenBound` | `(address _token)` | Token linked | `audit_log` |
| `TokenUnbound` | `(address _token)` | Token unlinked | `audit_log` |
| `ModuleInteraction` | `(address indexed target, bytes4 selector)` | `callModuleFunction` used | `audit_log` |

### 5.2 SupplyLimitModule

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Set supply limit | `setSupplyLimit(uint256)` | Via `MC.callModuleFunction()` | `_limit` (max tokens) |

**View functions:**

| Function | Returns | Use |
|---|---|---|
| `getSupplyLimit(address)` | `uint256` | Current supply limit for a compliance contract |

**Events to listen:**

| Event | Signature | When | DB Table |
|---|---|---|---|
| `SupplyLimitSet` | `(address _compliance, uint256 _limit)` | Limit changed | `compliance_events` |

---

## Phase 6: Agent & Role Management

### 6.1 AgentRole (on Token and IR)

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Add agent | `addAgent(address)` | Owner | Agent wallet address |
| Remove agent | `removeAgent(address)` | Owner | Agent wallet address |
| Check agent | `isAgent(address)` | Anyone (view) | Address to check |

**Events to listen:**

| Event | Signature | When | DB Table |
|---|---|---|---|
| `AgentAdded` | `(address indexed _agent)` | New agent registered | `role_changes` |
| `AgentRemoved` | `(address indexed _agent)` | Agent removed | `role_changes` |

Note: These events fire on both Token and IR contracts. Track the `contract_address` in the log to know which contract the agent was added to.

---

## Phase 7: Registry Configuration (Rarely Used in PoV)

### 7.1 ClaimTopicsRegistry (CTR)

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Add claim topic | `addClaimTopic(uint256)` | Owner | Topic ID (e.g., KYC=1, AML=2) |
| Remove claim topic | `removeClaimTopic(uint256)` | Owner | Topic ID |
| Get topics | `getClaimTopics()` | Anyone (view) | — |

**Events:** `ClaimTopicAdded(uint256 indexed claimTopic)`, `ClaimTopicRemoved(uint256 indexed claimTopic)`

### 7.2 TrustedIssuersRegistry (TIR)

| Action | Function | Called By | Parameters |
|---|---|---|---|
| Add issuer | `addTrustedIssuer(IClaimIssuer, uint256[])` | Owner | Issuer address, allowed claim topics |
| Remove issuer | `removeTrustedIssuer(IClaimIssuer)` | Owner | Issuer address |
| Update topics | `updateIssuerClaimTopics(IClaimIssuer, uint256[])` | Owner | Issuer address, new topics |

**View functions:** `getTrustedIssuers()`, `isTrustedIssuer(address)`, `getTrustedIssuerClaimTopics(IClaimIssuer)`, `getTrustedIssuersForClaimTopic(uint256)`, `hasClaimTopic(address, uint256)`

**Events:** `TrustedIssuerAdded(IClaimIssuer indexed, uint256[])`, `TrustedIssuerRemoved(IClaimIssuer indexed)`, `ClaimTopicsUpdated(IClaimIssuer indexed, uint256[])`

Note: CTR and TIR are empty in PoV (no claim topics, no trusted issuers). They become relevant when KYC/AML compliance claims are added.

---

## Complete Event Listener Checklist

Priority events the backend MUST listen to, ordered by importance:

### Critical (Core Business Logic)

| # | Event | Contract | Why |
|---|---|---|---|
| 1 | `Transfer(from, to, value)` | Token | Bond movement — mint/burn/transfer |
| 2 | `DVDTransferInitiated(transferID, maker, token1, amount1, taker, token2, amount2)` | DVDTransferManager | Settlement created |
| 3 | `DVDTransferExecuted(transferID)` | DVDTransferManager | Settlement completed |
| 4 | `DVDTransferCancelled(transferID)` | DVDTransferManager | Settlement cancelled |
| 5 | `IdentityRegistered(investorAddress, identity)` | IdentityRegistry | Investor whitelisted |
| 6 | `IdentityRemoved(investorAddress, identity)` | IdentityRegistry | Investor removed |
| 7 | `TREXSuiteDeployed(token, ir, irs, tir, ctr, mc, salt)` | TREXFactory | New deal created |

### Important (State Management)

| # | Event | Contract | Why |
|---|---|---|---|
| 8 | `Paused(userAddress)` | Token | Trading halted |
| 9 | `Unpaused(userAddress)` | Token | Trading resumed |
| 10 | `AddressFrozen(userAddress, isFrozen, owner)` | Token | Wallet frozen/unfrozen |
| 11 | `TokensFrozen(userAddress, amount)` | Token | Partial freeze |
| 12 | `TokensUnfrozen(userAddress, amount)` | Token | Partial unfreeze |
| 13 | `Approval(owner, spender, value)` | Token + CashToken | ERC-20 allowance set for DVD |
| 14 | `SupplyLimitSet(compliance, limit)` | SupplyLimitModule | Cap changed |

### Audit Trail (Nice to Have)

| # | Event | Contract | Why |
|---|---|---|---|
| 15 | `AgentAdded(agent)` | Token / IR | Role granted |
| 16 | `AgentRemoved(agent)` | Token / IR | Role revoked |
| 17 | `RecoverySuccess(lostWallet, newWallet, onchainID)` | Token | Wallet recovery |
| 18 | `CountryUpdated(investorAddress, country)` | IdentityRegistry | Country changed |
| 19 | `ModuleAdded(module)` | ModularCompliance | Compliance module added |
| 20 | `ModuleRemoved(module)` | ModularCompliance | Compliance module removed |
| 21 | `FeeModified(parity, token1, token2, ...)` | DVDTransferManager | DVD fee changed |

---

## End-to-End Transaction Flow (Backend Perspective)

```
1. DEPLOY PLATFORM
   Backend calls: gateway.deployTREXSuite(tokenDetails, claimDetails)
   Listen for:    TREXSuiteDeployed → save all 6 contract addresses to DB

2. WHITELIST INVESTORS
   Backend calls: ir.registerIdentity(investorWallet, zeroAddress, countryCode)
   Listen for:    IdentityRegistered → update whitelist table

3. UNPAUSE TOKEN
   Backend calls: token.unpause()
   Listen for:    Unpaused → update token state

4. MINT BONDS TO AGENT
   Backend calls: token.mint(bndAgentWallet, 5000)
   Listen for:    Transfer(0x0 → bndAgent, 5000) → record issuance

5. INVESTOR APPROVES CASH
   UI triggers:   cashToken.approve(dvdManager, cashAmount)   [investor wallet]
   Listen for:    Approval(investor, dvdManager, cashAmount)

6. AGENT APPROVES BONDS
   Backend calls: bondToken.approve(dvdManager, bondAmount)
   Listen for:    Approval(bndAgent, dvdManager, bondAmount)

7. AGENT INITIATES DVD
   Backend calls: dvdManager.initiateDVDTransfer(bondToken, bondAmt, investor, cashToken, cashAmt)
   Listen for:    DVDTransferInitiated → save transfer with PENDING status

8. AGENT SETTLES DVD
   Backend calls: dvdManager.takeDVDTransfer(transferID)
   Listen for:    DVDTransferExecuted → update transfer to SETTLED
                  Transfer(bndAgent → investor, bondAmt) → bond moved
                  Transfer(investor → bndAgent, cashAmt) → cash moved
```

---

## Suggested DB Schema (PostgreSQL)

```sql
-- Contract addresses per deal
CREATE TABLE deal_deployments (
    id SERIAL PRIMARY KEY,
    salt VARCHAR(255) NOT NULL,
    token_address VARCHAR(42) NOT NULL,
    ir_address VARCHAR(42) NOT NULL,
    irs_address VARCHAR(42) NOT NULL,
    tir_address VARCHAR(42) NOT NULL,
    ctr_address VARCHAR(42) NOT NULL,
    mc_address VARCHAR(42) NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- All token transfers (mint/burn/transfer)
CREATE TABLE token_transfers (
    id SERIAL PRIMARY KEY,
    contract_address VARCHAR(42) NOT NULL,
    from_address VARCHAR(42) NOT NULL,
    to_address VARCHAR(42) NOT NULL,
    amount NUMERIC NOT NULL,
    transfer_type VARCHAR(10) NOT NULL,  -- 'MINT', 'BURN', 'TRANSFER'
    tx_hash VARCHAR(66) NOT NULL,
    log_index INT NOT NULL,
    block_number BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (tx_hash, log_index)
);

-- Whitelist entries
CREATE TABLE whitelist_entries (
    id SERIAL PRIMARY KEY,
    investor_address VARCHAR(42) NOT NULL,
    identity_address VARCHAR(42),
    country_code INT,
    action VARCHAR(20) NOT NULL,  -- 'REGISTERED', 'REMOVED', 'UPDATED'
    tx_hash VARCHAR(66) NOT NULL,
    log_index INT NOT NULL,
    block_number BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (tx_hash, log_index)
);

-- DVD settlement tracking
CREATE TABLE dvd_transfers (
    id SERIAL PRIMARY KEY,
    transfer_id VARCHAR(66) NOT NULL UNIQUE,
    maker_address VARCHAR(42) NOT NULL,
    taker_address VARCHAR(42) NOT NULL,
    token1_address VARCHAR(42) NOT NULL,
    token1_amount NUMERIC NOT NULL,
    token2_address VARCHAR(42) NOT NULL,
    token2_amount NUMERIC NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',  -- 'PENDING', 'SETTLED', 'CANCELLED'
    initiated_tx_hash VARCHAR(66) NOT NULL,
    settled_tx_hash VARCHAR(66),
    initiated_block BIGINT NOT NULL,
    settled_block BIGINT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Token state changes
CREATE TABLE token_state (
    id SERIAL PRIMARY KEY,
    contract_address VARCHAR(42) NOT NULL,
    event_type VARCHAR(30) NOT NULL,  -- 'PAUSED', 'UNPAUSED', 'ADDRESS_FROZEN', 'TOKENS_FROZEN', 'TOKENS_UNFROZEN'
    target_address VARCHAR(42),
    value VARCHAR(255),
    agent_address VARCHAR(42),
    tx_hash VARCHAR(66) NOT NULL,
    log_index INT NOT NULL,
    block_number BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (tx_hash, log_index)
);

-- Block cursor for crash recovery
CREATE TABLE sync_status (
    id SERIAL PRIMARY KEY,
    contract_address VARCHAR(42) NOT NULL UNIQUE,
    last_processed_block BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## Requirements

- Node.js — v18+
- Hardhat — v3.22.0
