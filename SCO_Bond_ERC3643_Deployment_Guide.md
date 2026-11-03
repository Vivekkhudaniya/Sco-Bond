# SCO Bond Contracts on ERC-3643 — Deployment Guide

## Do we need to clone T-REX?

**Yes, but only partially.** Per the doc:

- We use **all the official T-REX contracts unchanged** (Token, IdentityRegistry, IdentityRegistryStorage, ClaimTopicsRegistry, TrustedIssuersRegistry, ModularCompliance, all modules, Gateway, ImplementationAuthority, proxies, DVDTransferManager, etc.)
- We make **one small change** to **TREXFactory** — remove the line that creates an ONCHAINID for the token and remove the `idFactory` constructor parameter
- We add **one new contract**: `MockCashToken` (a simple ERC-20 for test euros)
- We **don't deploy** any ONCHAINID contracts (Identity, ClaimIssuer, IdFactory)

So the approach is:
1. Clone the official Tokeny T-REX repo
2. Install it as a Foundry project
3. Modify only `TREXFactory.sol` (remove ONCHAINID creation)
4. Write `MockCashToken.sol`
5. Write deployment scripts

---

## Step-by-step contract understanding

Here's the deployment order from the doc, grouped into **what each does and why**:

### Phase A: Platform setup (deploy once, shared by all deals)

| Step | Contract(s) | What it does | Why first |
|---|---|---|---|
| **1** | `Token`, `IdentityRegistry`, `IdentityRegistryStorage`, `ClaimTopicsRegistry`, `TrustedIssuersRegistry`, `ModularCompliance` (implementations) | These are **master copies** of the code. They're never used directly — each deal gets proxy clones pointing to them. | The ImplementationAuthority needs their addresses |
| **2** | `TREXImplementationAuthority` | A registry that says "version 1.0.0 uses these 6 implementations". Proxies look here to find the actual code. | The Factory needs it to create deals |
| **3** | `TREXFactory` *(our modified version)* | Creates all 6 per-deal contracts in one call (`deployTREXSuite`). Our version skips ONCHAINID creation. | The Gateway calls it |
| **4** | `TREXGateway` | Front door — only approved deployers can call the factory through it. Access control. | Needs the factory address |
| **5** | `SupplyLimitModule` (behind `ModuleProxy`) | Compliance module that caps total supply (5,000 bonds for deal 51X5RT). Shared across deals. | Plugged into each deal's compliance at deploy |
| **6** | `MockCashToken` + `DVDTransferManager` | Test EURd (6 decimals) + T-REX's atomic swap contract (bonds-for-cash in one tx). | Needed for settlement |

### Phase B: Create a deal (one transaction)

| Step | What happens |
|---|---|
| **7** | Platform Admin calls `gateway.deployTREXSuite(...)` with token name, symbol, compliance modules, supply limit, empty claim topics/issuers, `ONCHAINID = address(0)`. This creates: Token + proxy, IR + proxy, IRS + proxy, CTR + proxy, TIR + proxy, MC + proxy — all linked together. |

### Phase C: Run the deal

| Step | What happens |
|---|---|
| **8** | Registrar calls `identityRegistry.batchRegisterIdentity(wallets, wallets, [0,0,0,0])` — each wallet's "identity" is itself. This is the whitelist. |
| **9** | B&D agent calls `token.mint(BND_SAFE, 5000)` then `token.unpause()` |
| **10** | Fund investors with MockCashToken, investors `approve(dvd, amount)`, B&D `token.approve(dvd, 5000)` |
| **11** | B&D calls `dvd.initiateDVDTransfer(token, amount, investor, cash, cashAmount)` per trade |
| **12** | Each investor calls `dvd.takeDVDTransfer(transferID)` — atomic swap |

---

## Key things to understand before deploying

1. **Proxy pattern**: Each deal's contracts are proxies (cheap clones) pointing to the implementations from Step 1. Upgradeable via ImplementationAuthority.

2. **The whitelist trick**: In standard ERC-3643, `isVerified` checks ONCHAINID claims. In our design, since ClaimTopicsRegistry is empty (no topics required), the check short-circuits to just "is the wallet registered in IdentityRegistryStorage?" — a pure whitelist.

3. **DVDTransferManager** (Delivery vs. Delivery): B&D offers bonds, investor accepts with cash — both legs move atomically. If either fails, nothing moves. It uses `transferFrom` with allowances, not agent powers.

4. **Order matters**: Mint can't happen before whitelist (because `mint` calls `isVerified` on the recipient). Token must be unpaused before swaps (DVD uses `transferFrom`).
