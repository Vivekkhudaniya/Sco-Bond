# All Contracts — Folder-by-Folder Walkthrough

Every Solidity file in the `contracts/` directory, organized by folder.
Each contract has a 2-line explanation of what it does and why it exists.

**Total: 82 contracts. ~30 actively used by us. ~52 come with the T-REX repo but are unused.**

---

## `token/` — The Bond Token (3 files)

| File | Purpose |
|---|---|
| **Token.sol** | The main ERC-3643 security token. Implements transfer, mint, burn, pause, freeze, and approve. Every transfer checks `isVerified()` on the receiver and `canTransfer()` on the compliance contract before allowing it — this is what makes it a regulated token instead of a plain ERC-20. |
| **IToken.sol** | Interface that defines all Token function signatures and events (Transfer, Paused, Unpaused, AddressFrozen, TokensFrozen, RecoverySuccess, etc.). Other contracts import this to interact with the Token without needing the full implementation. |
| **TokenStorage.sol** | Storage layout contract holding all state variables: `_balances`, `_allowances`, `_totalSupply`, `_tokenName`, `_frozen`, `_frozenTokens`, `_tokenPaused`, plus references to IdentityRegistry and ModularCompliance. Separated from Token.sol so proxy upgrades don't corrupt the storage slot positions. |

---

## `registry/` — The Whitelist System (11 files)

### `registry/implementation/` — Actual logic

| File | Purpose |
|---|---|
| **IdentityRegistry.sol** | The whitelist desk — has `registerIdentity()`, `deleteIdentity()`, `batchRegisterIdentity()`, and the critical `isVerified()` function. Every Token transfer calls `isVerified()` on the receiver; if the wallet isn't registered here, the transfer reverts. |
| **IdentityRegistryStorage.sol** | The filing cabinet behind the desk — stores the actual `wallet → identity address + country code` mappings. Separated from IdentityRegistry so one storage can be shared across multiple token deals without duplicating investor data. |
| **ClaimTopicsRegistry.sol** | Stores a list of required claim topic IDs that investors must have. In our design this is deployed **empty** — no topics required. That's what makes `isVerified()` short-circuit to a pure whitelist without checking any claims. |
| **TrustedIssuersRegistry.sol** | Stores a list of trusted claim issuer addresses and which claim topics each issuer can sign. In our design this is deployed **empty** — no issuers needed because no claims are required. |

### `registry/interface/` — Function signatures only

| File | Purpose |
|---|---|
| **IIdentityRegistry.sol** | Interface for IdentityRegistry. Defines function signatures like `registerIdentity`, `deleteIdentity`, `isVerified`, and events like `IdentityRegistered`, `IdentityRemoved`. Other contracts import this to talk to the registry. |
| **IIdentityRegistryStorage.sol** | Interface for IdentityRegistryStorage. Defines `addIdentityToStorage`, `removeIdentityFromStorage`, `modifyStoredIdentity`, and read functions like `storedIdentity` and `storedInvestorCountry`. |
| **IClaimTopicsRegistry.sol** | Interface for ClaimTopicsRegistry. Defines `addClaimTopic`, `removeClaimTopic`, `getClaimTopics`. |
| **ITrustedIssuersRegistry.sol** | Interface for TrustedIssuersRegistry. Defines `addTrustedIssuer`, `removeTrustedIssuer`, `getTrustedIssuers`, and checks like `isTrustedIssuer`. |

### `registry/storage/` — Storage layouts for proxy safety

| File | Purpose |
|---|---|
| **IRStorage.sol** | Storage variables for IdentityRegistry — holds references to ClaimTopicsRegistry, TrustedIssuersRegistry, and IdentityRegistryStorage. Separated so proxy upgrades preserve storage slot positions. |
| **IRSStorage.sol** | Storage variables for IdentityRegistryStorage — holds the `wallet → identity` and `wallet → country` mappings, plus the list of bound identity registries. |
| **CTRStorage.sol** | Storage variables for ClaimTopicsRegistry — holds the `claimTopics` array (the list of required claim topic IDs). |
| **TIRStorage.sol** | Storage variables for TrustedIssuersRegistry — holds the `trustedIssuers` list and the mapping of issuer → allowed claim topics. |

---

## `proxy/` — Lightweight Clones (10 files)

Each deal deploys proxy contracts instead of full contracts. Proxies are cheap to deploy and delegate all calls to the implementation contracts registered in the IA.

### `proxy/` — One proxy per deal contract

| File | Purpose |
|---|---|
| **AbstractProxy.sol** | Base class for all T-REX proxies. Stores the IA address in a special storage slot (`keccak256("ERC-3643.proxy.beacon")`), has a `fallback()` function that delegates all calls to the implementation looked up from the IA. Every other proxy inherits this. |
| **TokenProxy.sol** | Proxy for Token. Constructor stores the IA address, looks up the Token implementation, and calls `Token.init()` via delegatecall to initialize the token's name, symbol, decimals, identity registry, and compliance references. |
| **IdentityRegistryProxy.sol** | Proxy for IdentityRegistry. Constructor stores IA address, looks up IR implementation, calls `init()` with TIR, CTR, and IRS addresses to wire the registry to its dependencies. |
| **IdentityRegistryStorageProxy.sol** | Proxy for IdentityRegistryStorage. Constructor stores IA address, looks up IRS implementation, calls `init()`. Simplest proxy — IRS has no external dependencies at init time. |
| **ClaimTopicsRegistryProxy.sol** | Proxy for ClaimTopicsRegistry. Constructor stores IA address, looks up CTR implementation, calls `init()`. |
| **TrustedIssuersRegistryProxy.sol** | Proxy for TrustedIssuersRegistry. Constructor stores IA address, looks up TIR implementation, calls `init()`. |
| **ModularComplianceProxy.sol** | Proxy for ModularCompliance. Constructor stores IA address, looks up MC implementation, calls `init()`. |

### `proxy/authority/` — Version registry and its factory

| File | Purpose |
|---|---|
| **TREXImplementationAuthority.sol** | The code library / version registry. Maps a version number (e.g. `4.0.0`) to the 6 implementation contract addresses. Every proxy asks it "where is my code?" via getters like `getTokenImplementation()`. Also supports upgrades — change the version and all proxies instantly use new code. |
| **ITREXImplementationAuthority.sol** | Interface that defines the `Version` struct (`major`, `minor`, `patch`), the `TREXContracts` struct (6 implementation addresses), and all function signatures like `addAndUseTREXVersion`, `useTREXVersion`, `getContracts`. |
| **IAFactory.sol** | Factory that creates private IA copies. When a token issuer wants to detach from the shared platform IA and control their own upgrades independently, the main IA calls IAFactory to deploy a new auxiliary IA just for that token. **Not needed for PoV.** |
| **IIAFactory.sol** | Interface for IAFactory. Defines `deployIA()` and `deployedByFactory()`. |

### `proxy/interface/`

| File | Purpose |
|---|---|
| **IProxy.sol** | Interface that all proxies implement. Defines two functions: `setImplementationAuthority()` (switch to a new IA) and `getImplementationAuthority()` (read current IA address). |

---

## `factory/` — Deal Deployment (4 files)

| File | Purpose |
|---|---|
| **TREXFactory.sol** | The builder — `deployTREXSuite()` deploys all 6 proxy contracts for a deal in one transaction using CREATE2 (deterministic addresses). Wires them together, adds agents, binds compliance modules, and transfers ownership. **Our modified version** — removed ONCHAINID auto-creation. |
| **ITREXFactory.sol** | Interface that defines the `TokenDetails` struct (owner, name, symbol, decimals, agents, compliance modules, etc.) and `ClaimDetails` struct (claim topics, issuers). Also declares events like `TREXSuiteDeployed` which outputs all 6 deployed proxy addresses. |
| **TREXGateway.sol** | The front door / security guard. Sits in front of the Factory and controls WHO can create deals. Maintains a deployer whitelist, optional deployment fees with per-deployer discounts. Owns the Factory so only it can call `deployTREXSuite`. |
| **ITREXGateway.sol** | Interface that defines the `Fee` struct (fee amount, fee token, fee collector) and all Gateway function signatures like `addDeployer`, `deployTREXSuite`, `setPublicDeploymentStatus`, `enableDeploymentFee`. |

---

## `compliance/` — Transfer Rules (21 files)

### `compliance/modular/` — Current system (used by us)

| File | Purpose |
|---|---|
| **ModularCompliance.sol** | The rule engine. Holds a list of plugged-in modules (max 25). Before every transfer, the Token calls `canTransfer()` which loops through each module's `moduleCheck()`. After a transfer, calls `transferred()` which loops through each module's `moduleTransferAction()`. The gatekeeper for all transfer rules. |
| **IModularCompliance.sol** | Interface defining `canTransfer`, `transferred`, `created`, `destroyed`, `addModule`, `removeModule`, `callModuleFunction`, `getTokenBound`, `isModuleBound`. |
| **MCStorage.sol** | Storage layout for ModularCompliance — holds the bound token address and the array of bound module addresses. |

### `compliance/modular/modules/` — Plug-in rule modules

| File | Purpose | Used by us? |
|---|---|---|
| **SupplyLimitModule.sol** | Caps the total supply of tokens. When minting (`_from == address(0)`), checks if `totalSupply + mintAmount > limit` and blocks if it exceeds. For deal 51X5RT the limit is 5,000 bonds. | **Yes** |
| **MaxBalanceModule.sol** | Caps the maximum token balance per wallet. Prevents any single investor from holding more than a configured amount. Useful for concentration limits. | No |
| **CountryAllowModule.sol** | Only allows transfers TO wallets whose country code is in an allow-list. Looks up country from IdentityRegistryStorage. Used for jurisdictional restrictions. | No |
| **CountryRestrictModule.sol** | Blocks transfers TO wallets from specific blacklisted countries. The inverse of CountryAllowModule. | No |
| **TransferRestrictModule.sol** | Blocks specific wallet-to-wallet transfer pairs. An admin can say "wallet A cannot send to wallet B". | No |
| **ConditionalTransferModule.sol** | Transfers require pre-approval before executing. An agent must call `approveTransfer()` before the actual `transfer()` will succeed. Adds a compliance approval step. | No |
| **TimeTransfersLimitsModule.sol** | Limits how many tokens a single wallet can transfer within a configurable time window. E.g., "max 100 tokens per 24 hours per wallet". | No |
| **TimeExchangeLimitsModule.sol** | Similar to TimeTransfersLimits but specifically for exchange wallets. Limits how many tokens can be sent to tagged exchange addresses per time period. | No |
| **ExchangeMonthlyLimitsModule.sol** | Monthly cap on how many tokens can be sent to exchange wallets. Resets each month. | No |
| **TransferFeesModule.sol** | Automatically deducts a percentage fee on every transfer and sends it to a configured fee wallet. E.g., 0.5% of every transfer goes to the platform. | No |
| **TokenListingRestrictionsModule.sol** | Restricts which external tokens can interact with this token. Controls which token parities are allowed in DeFi contexts. | No |
| **AbstractModule.sol** | Base class for non-upgradeable compliance modules. Provides the `onlyComplianceCall` modifier that ensures only the bound ModularCompliance contract can call module functions. | — |
| **AbstractModuleUpgradeable.sol** | Base class for upgradeable compliance modules. Same as AbstractModule but uses OpenZeppelin's upgradeable pattern. SupplyLimitModule extends this. | — |
| **ModuleProxy.sol** | ERC1967 proxy wrapper for compliance modules. Allows modules to be deployed behind a proxy so they can be upgraded later without changing the address plugged into ModularCompliance. | **Yes** |
| **IModule.sol** | Interface all modules must implement: `moduleCheck()` (called before transfer), `moduleTransferAction()` (called after transfer), `moduleMintAction()`, `moduleBurnAction()`, `name()`, `isPlugAndPlay()`. | — |

#### Quick Summary — All Compliance Modules at a Glance

| Module | What It Does | Used by Us? |
|---|---|---|
| **SupplyLimitModule** | Caps total token supply. On mint, checks if `totalSupply + amount > limit` and blocks it. Our limit is 5,000 bonds. | **Yes** |
| **MaxBalanceModule** | Caps max tokens per wallet. Prevents one investor from holding more than X bonds. | No |
| **CountryAllowModule** | Only allows transfers to wallets from an approved country list (looked up from IdentityRegistryStorage). | No |
| **CountryRestrictModule** | Blocks transfers to wallets from blacklisted countries. Inverse of CountryAllowModule. | No |
| **TransferRestrictModule** | Blocks specific wallet-to-wallet pairs. Admin can say "A cannot send to B". | No |
| **ConditionalTransferModule** | Transfers need pre-approval. An agent must call `approveTransfer()` before the actual `transfer()` works. | No |
| **TimeTransfersLimitsModule** | Limits how many tokens a wallet can transfer in a time window. E.g., "max 100 bonds per 24 hours". | No |
| **TimeExchangeLimitsModule** | Same as above but only for transfers to tagged exchange wallets. | No |
| **ExchangeMonthlyLimitsModule** | Monthly cap on tokens sent to exchange wallets. Resets each month. | No |
| **TransferFeesModule** | Auto-deducts a % fee on every transfer and sends it to a fee wallet. E.g., 0.5% per transfer. | No |
| **TokenListingRestrictionsModule** | Restricts which external tokens can interact with this token in DeFi contexts. | No |

> **How modules work:** ModularCompliance holds a list of bound modules (max 25). Before every transfer, Token calls `compliance.canTransfer()` which loops through each module's `moduleCheck()`. If any module returns `false`, the transfer reverts. Modules can be added/removed anytime with `compliance.addModule(address)` / `compliance.removeModule(address)`.
>
> **Why only SupplyLimitModule for our PoV:** We just need to cap the bond supply at 5,000. We don't need country restrictions (our whitelist handles access), transfer limits, fees, or approval workflows. But any of these can be plugged in later — that's the beauty of the modular design.

### `compliance/legacy/` — Old system (not used)

| File | Purpose |
|---|---|
| **BasicCompliance.sol** | Old monolithic compliance contract from T-REX v3. All rules were baked into one contract instead of separate modules. Replaced by ModularCompliance in v4. Kept for backwards compatibility. |
| **DefaultCompliance.sol** | Simplest legacy compliance — allows all transfers with no restrictions. Used as a placeholder when no compliance rules are needed. |
| **ICompliance.sol** | Legacy compliance interface. Defines the old `canTransfer`, `transferred`, `created`, `destroyed` signatures that BasicCompliance implements. |

### `compliance/legacy/features/` — Old rule features (7 files)

| File | Purpose |
|---|---|
| **SupplyLimit.sol** | Legacy version of supply cap. Inherits BasicCompliance and adds supply checking. Replaced by SupplyLimitModule. |
| **MaxBalance.sol** | Legacy version of max balance per wallet. Replaced by MaxBalanceModule. |
| **CountryWhitelisting.sol** | Legacy country allow-list. Replaced by CountryAllowModule. |
| **CountryRestrictions.sol** | Legacy country blacklist. Replaced by CountryRestrictModule. |
| **ExchangeMonthlyLimits.sol** | Legacy exchange monthly limits. Replaced by ExchangeMonthlyLimitsModule. |
| **DayMonthLimits.sol** | Legacy daily/monthly transfer limits. Replaced by TimeTransfersLimitsModule. |
| **ApproveTransfer.sol** | Legacy transfer approval system. Replaced by ConditionalTransferModule. |

### `compliance/legacy/test/` — Legacy test contracts (7 files)

| File | Purpose |
|---|---|
| **SupplyLimitTest.sol** | Test contract for legacy SupplyLimit feature. |
| **MaxBalanceTest.sol** | Test contract for legacy MaxBalance feature. |
| **CountryWhitelistingTest.sol** | Test contract for legacy CountryWhitelisting feature. |
| **CountryRestrictionsTest.sol** | Test contract for legacy CountryRestrictions feature. |
| **ExchangeMonthlyLimitsTest.sol** | Test contract for legacy ExchangeMonthlyLimits feature. |
| **DayMonthLimitsTest.sol** | Test contract for legacy DayMonthLimits feature. |
| **ApproveTransferTest.sol** | Test contract for legacy ApproveTransfer feature. |

> **The entire `compliance/legacy/` folder is not used.** The modular system replaced it in T-REX v4. These files exist in the repo for backwards compatibility and upgrade testing.

---

## `roles/` — Access Control (8 files)

### `roles/` — Core role system

| File | Purpose |
|---|---|
| **Roles.sol** | A library that implements a simple role: a mapping of `address → bool`. Provides `add()`, `remove()`, and `has()` functions. The building block that AgentRole and all permissioning contracts use under the hood. |
| **AgentRole.sol** | Non-upgradeable agent role contract. Adds `onlyAgent` modifier, `addAgent()`, `removeAgent()`, `isAgent()`. Owner can add/remove agents. Used by Factory (non-proxy) and Gateway. |
| **AgentRoleUpgradeable.sol** | Same as AgentRole but extends OpenZeppelin's `OwnableUpgradeable` instead of `Ownable`. Used by contracts deployed behind proxies — Token and IdentityRegistry inherit this so agents survive proxy upgrades. |

### `roles/permissioning/agent/` — Fine-grained agent roles

| File | Purpose |
|---|---|
| **AgentManager.sol** | Optional wrapper around Token agent functions (forcedTransfer, mint, burn, freeze, pause). Instead of giving a wallet direct agent access, you give an ONCHAINID identity agent access, and AgentManager checks that the caller holds the right key on that identity. Adds multi-sig-style control. **Not needed for PoV.** |
| **AgentRoles.sol** | Defines specific agent sub-roles: TransferManager, FreezeManager, ComplianceManager, WhitelistManager, ComplianceAgent. Lets you split agent powers across different people instead of one wallet having all agent permissions. |
| **AgentRolesUpgradeable.sol** | Same as AgentRoles but upgradeable. For use behind proxies. |

### `roles/permissioning/owner/` — Fine-grained owner roles

| File | Purpose |
|---|---|
| **OwnerManager.sol** | Optional wrapper around Token owner functions (setCompliance, setIdentityRegistry, setName, etc.). Similar to AgentManager but for owner operations. Uses ONCHAINID key checks for multi-sig-style governance. **Not needed for PoV.** |
| **OwnerRoles.sol** | Defines specific owner sub-roles: ComplianceSetter, RegistrySetter, ClaimRegistryManager, IssuersRegistryManager, TokenInfoManager. Lets you split owner powers. |
| **OwnerRolesUpgradeable.sol** | Same as OwnerRoles but upgradeable. |

> **The entire `roles/permissioning/` folder is optional.** It adds ONCHAINID-based multi-sig controls on top of the basic agent/owner system. For our PoV we use simple wallet-based ownership — one wallet is the agent, one wallet is the owner.

---

## `DVD/` — Atomic Swap (1 file)

| File | Purpose |
|---|---|
| **DVDTransferManager.sol** | Delivery vs Delivery — the atomic swap engine. B&D Agent calls `initiateDVDTransfer()` to offer bonds in exchange for cash. B&D Agent also calls `takeDVDTransfer()` to settle — both legs (bonds → investor, cash → B&D) execute in one transaction. If either side fails, nothing moves. **Our change:** both `initiateDVDTransfer` and `takeDVDTransfer` are restricted to TREX agents only — investors never call the DVD contract directly (they only `approve` cash). Also supports `cancelDVDTransfer()` and optional per-parity fees via `modifyFee()`. **Used by us for settlement.** |

---

## `DVA/` — Approval-Based Swap (2 files)

| File | Purpose |
|---|---|
| **DVATransferManager.sol** | Delivery vs Approval — a more complex swap that requires a chain of approvals (from both counterparts and designated approvers) before the swap executes. Designed for regulated environments where transfers need sign-off from compliance officers. **Not used by us** — DVD is simpler and sufficient. |
| **IDVATransferManager.sol** | Interface for DVATransferManager. Defines the `Transfer` struct, approval functions, and events. |

---

## `MockCashToken.sol` — Test Money (1 file)

| File | Purpose |
|---|---|
| **MockCashToken.sol** | **Our custom contract.** A simple ERC-20 token named "Euro Digital" with symbol "EURd" and 6 decimals. Only the owner can mint. Used as the cash leg in DVD swaps to simulate real euro-denominated settlement on testnet. |

---

## `_testContracts/` — Test Helpers (6 files)

| File | Purpose |
|---|---|
| **TestERC20.sol** | A bare-bones ERC-20 token with public mint for testing. Used in T-REX's test suite to simulate non-TREX tokens in DVD swaps and compliance checks. |
| **MockContract.sol** | A generic mock contract that can be configured to return arbitrary data. Used in unit tests to simulate external contract responses without deploying real contracts. |
| **ClaimIssuerTrick.sol** | A test helper that simulates a malicious or misbehaving claim issuer. Used to test edge cases in the TrustedIssuersRegistry and claim verification logic. |
| **OIDImports.sol** | A dummy file that imports ONCHAINID contracts (Identity, ClaimIssuer, IdFactory). Forces Foundry to compile these dependencies so their artifacts are available for testing, even though we don't deploy them directly. |
| **TestUpgradedCountryAllowModule.sol** | A modified version of CountryAllowModule used to test the module upgrade path. Verifies that a compliance module can be upgraded behind a ModuleProxy without losing state. |

### `_testContracts/v_3_5_2/` — Legacy version contracts

| File | Purpose |
|---|---|
| **LegacyToken_3_5_2.sol** | An old T-REX v3.5.2 token contract. Used to test that proxies deployed with the old version can be upgraded to the current version without breaking. |
| **LegacyProxy.sol** | An old proxy format from v3.5.2. Used in upgrade tests to verify the migration path from old proxy format to the current AbstractProxy. |
| **LegacyIA.sol** | An old ImplementationAuthority from v3.5.2. Used in upgrade tests to verify that `changeImplementationAuthority()` works when migrating from old IA format. |

> **All `_testContracts/` files are for testing only. None are deployed.**

---

## What We Actually Use vs What's Just There

| Category | Actively Used | Not Used |
|---|---|---|
| **token/** | Token, IToken, TokenStorage (3) | — |
| **registry/implementation/** | All 4 | — |
| **registry/interface/** | All 4 | — |
| **registry/storage/** | All 4 | — |
| **proxy/** | AbstractProxy + 6 proxies (7) | — |
| **proxy/authority/** | IA + IIA (2) | IAFactory, IIAFactory (2) |
| **proxy/interface/** | IProxy (1) | — |
| **factory/** | All 4 | — |
| **compliance/modular/** | ModularCompliance, IModularCompliance, MCStorage (3) | — |
| **compliance/modular/modules/** | SupplyLimitModule, ModuleProxy, AbstractModuleUpgradeable, IModule (4) | 10 other modules, AbstractModule |
| **compliance/legacy/** | — | All 17 files |
| **roles/** | Roles, AgentRole, AgentRoleUpgradeable (3) | — |
| **roles/permissioning/** | — | All 6 files |
| **DVD/** | DVDTransferManager (1) | — |
| **DVA/** | — | Both files (2) |
| **MockCashToken.sol** | Yes (1) | — |
| **_testContracts/** | — | All 6 files |
| | **~37 contracts used** | **~45 contracts unused** |
