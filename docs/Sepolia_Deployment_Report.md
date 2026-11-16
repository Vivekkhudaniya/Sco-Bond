# SCO Bond — Sepolia Deployment Report

**Network:** Sepolia Testnet (Chain ID: 11155111)
**Date:** 2026-11-05
**Deployer:** `0xE801d94Be3836c5779319384f7316b0a208209b6`

---

## Deployed Contract Addresses

### Platform Contracts (shared across all deals)

| Contract | Address |
|---|---|
| Token Implementation | `0x252e246B72065330C44Dec74Bf16f4A18e46a3b8` |
| IdentityRegistry Implementation | `0x0c6a96fab747fE34263A7D4C2E8B488a19eFa0c4` |
| IdentityRegistryStorage Implementation | `0x705db864ee9633eC447091d9630A9D58C70b2DA1` |
| ClaimTopicsRegistry Implementation | `0x6FD3925b323e879105Dbf68a038CCFaF50908c4C` |
| TrustedIssuersRegistry Implementation | `0xB9194A430e71A02A2FA8fb8adf27300764c31fCD` |
| ModularCompliance Implementation | `0x8D558f04B640D488EeDee64A8Be9dFd28a69F8d2` |
| ImplementationAuthority (IA) | `0xf8B015a5246ED0962AB7BBe70Ec4c5f26C0F3920` |
| TREXFactory | `0x0481102f4AeFB1E5e7e78062F0650477d671C747` |
| TREXGateway | `0x79368268a6d1442703540C761b254664841D71d3` |
| SupplyLimitModule (impl) | `0x99043dd24A13Bb577524C71B3A70b9f09E1172E2` |
| SupplyLimitModule (proxy) | `0x8A6c138a47d685A8b03ced4a39169298c03eaB82` |
| MockCashToken (EURd) | `0x7506c7108e391f1d5ce89f3820FbcEa52e68f560` |
| DVDTransferManager | `0xbe44ecE39e40BCCe90a82D47f50dF2d9e9025542` |

### Deal Proxies (SCO Bond 51X5RT)

| Contract | Address |
|---|---|
| Token Proxy (SCO51X) | `0x401F11E84159296995b2781Ae96DAc5cB1f86007` |
| IdentityRegistry Proxy | `0x66FA53c28c2d282C98b01686E6829A14cb2d5C45` |
| IdentityRegistryStorage Proxy | `0x103232a704c9129e8f803Dd93Bc027b5381aDC79` |
| TrustedIssuersRegistry Proxy | `0xD3E7608a2B1561c0eF898fEeD3805fA0607066Df` |
| ClaimTopicsRegistry Proxy | `0x2744A4D93548de68E697027B313b6F7dd214A38E` |
| ModularCompliance Proxy | `0x2C6f6F1683527B012Ecb7f40A15D1BAF190D307F` |

---

## Wallets

| Role | Address |
|---|---|
| Deployer / Registrar / B&D Agent | `0xE801d94Be3836c5779319384f7316b0a208209b6` |
| Investor 1 | `0x1A6346C1F6Fd5d23b35755Af0B20df03fddC677A` |
| Investor 2 | `0x301Ab10C2Cb1dEC37e0a9A73B4626013a3685eaC` |

---

## Step-by-Step — What Was Done

### Phase A: Platform Setup

**Step 1 — Deploy 6 Implementation Contracts**
Deployed the master copies of Token, IdentityRegistry, IdentityRegistryStorage, ClaimTopicsRegistry, TrustedIssuersRegistry, and ModularCompliance. These are the shared logic contracts — proxies delegate all calls to them.

**Step 2 — Deploy ImplementationAuthority (IA)**
Deployed the version registry. It maps a version number to the 6 implementation addresses. All proxies ask the IA where their code lives.

**Step 3 — Register Version 4.0.0 in IA**
Called `addAndUseTREXVersion({4,0,0}, contracts)` to register all 6 implementation addresses under version 4.0.0 and set it as the active version.

**Step 4 — Deploy TREXFactory**
Deployed the factory that builds deals. Constructor takes the IA address so it knows which implementations to use when creating proxies.

**Step 5 — Link Factory to IA**
Called `ia.setTREXFactory(factoryAddress)` so the IA knows which factory is authorized to deploy deals using its implementations.

**Step 6 — Deploy TREXGateway**
Deployed the access control front door. It controls who can create deals through the Factory. Constructor takes the Factory address and `publicDeploymentStatus = false` (whitelist mode).

**Step 7 — Transfer Factory Ownership to Gateway**
Called `factory.transferOwnership(gatewayAddress)` so only the Gateway can call `deployTREXSuite()` on the Factory.

**Step 8 — Add Deployer to Gateway Whitelist**
Called `gateway.addDeployer(deployerAddress)` to authorize our admin wallet to create deals through the Gateway.

**Step 9 — Deploy SupplyLimitModule Implementation**
Deployed the supply cap logic contract. This module blocks minting if `totalSupply + mintAmount > limit`.

**Step 10 — Deploy ModuleProxy for SupplyLimitModule**
Deployed an ERC1967 proxy pointing to the SupplyLimitModule implementation. Called `initialize()` via the proxy constructor. This proxy address is what gets plugged into the deal's compliance.

**Step 11 — Deploy MockCashToken (EURd)**
Deployed our test stablecoin — ERC-20 named "Euro Digital" with symbol "EURd" and 6 decimals. Only the owner (deployer) can mint.

**Step 12 — Deploy DVDTransferManager**
Deployed the atomic swap engine. Handles `initiateDVDTransfer` (B&D offers bonds for cash) and `takeDVDTransfer` (investor accepts and both legs move atomically).

---

### Phase B: Create the Deal

**Step 13 — Deploy Deal via `gateway.deployTREXSuite()`**
Called `gateway.deployTREXSuite(tokenDetails, claimDetails)` which created 6 proxy contracts in one transaction:
- **tokenDetails:** owner = deployer, name = "SCO Bond 51X5RT", symbol = "SCO51X", decimals = 0, tokenAgents = [deployer], irAgents = [deployer], complianceModules = [SupplyLimitModule proxy], complianceSettings = [setSupplyLimit(5000)]
- **claimDetails:** all empty (no claim topics, no issuers — pure whitelist mode)

The Factory deployed Token, IR, IRS, CTR, TIR, and MC proxies, wired them together, added agents, bound the SupplyLimitModule, and set the supply limit to 5,000.

---

### Phase C: Run the Deal

**Step 14 — Whitelist Wallets**
Called `ir.batchRegisterIdentity([bndAgent, investor1, investor2], [bndAgent, investor1, investor2], [0, 0, 0])` to register all 3 wallets in the IdentityRegistry. Without this, transfers to these wallets would revert because `isVerified()` would return false.

**Step 15 — Mint 5,000 Bonds**
Called `token.mint(bndAgentAddress, 5000)` as the B&D agent. All 5,000 bonds now sit in the B&D agent's wallet, ready for distribution.

**Step 16 — Unpause Token**
Called `token.unpause()`. The token starts paused after deployment — this enables transfers.

**Step 17 — Mint EURd to Investors**
Called `cashToken.mint(investor1, 2500000000)` and `cashToken.mint(investor2, 2500000000)`. Each investor received 2,500 EURd (2,500 × 10^6 base units at 6 decimals).

**Step 18 — Investors Approve DVD Contract for EURd**
Each investor called `cashToken.approve(dvdAddress, 2500000000)` to let the DVDTransferManager pull their EURd during the atomic swap.

**Step 19 — B&D Agent Approves DVD Contract for Bonds**
Called `token.approve(dvdAddress, 5000)` so the DVDTransferManager can pull bonds from the B&D agent's wallet during the swap.

**Step 20 — B&D Initiates DVD Transfers**
Called `dvd.initiateDVDTransfer()` twice:
- Transfer 1: 2,500 bonds → Investor 1, in exchange for 2,500 EURd
- Transfer 2: 2,500 bonds → Investor 2, in exchange for 2,500 EURd

Each call returns a unique `transferID` (bytes32 hash).

**Step 21 — B&D Agent Settles Atomic Swaps**
B&D Agent called `dvd.takeDVDTransfer(transferID)` for each investor (agent-only — our change):
- Bonds moved from B&D agent → investor
- EURd moved from investor → B&D agent
- Both legs in one transaction — if either fails, nothing moves

---

## Final Balances

| Wallet | Bonds (SCO51X) | EURd |
|---|---|---|
| B&D Agent (`0xE801...09b6`) | 0 | 5,000 EUR |
| Investor 1 (`0x1A63...677A`) | 2,500 | 0 EUR |
| Investor 2 (`0x301A...5eaC`) | 2,500 | 0 EUR |

---

## Verify on Etherscan

All contracts can be viewed at:
- Token: `https://sepolia.etherscan.io/address/0x401F11E84159296995b2781Ae96DAc5cB1f86007`
- DVDTransferManager: `https://sepolia.etherscan.io/address/0xbe44ecE39e40BCCe90a82D47f50dF2d9e9025542`
- MockCashToken: `https://sepolia.etherscan.io/address/0x7506c7108e391f1d5ce89f3820FbcEa52e68f560`
