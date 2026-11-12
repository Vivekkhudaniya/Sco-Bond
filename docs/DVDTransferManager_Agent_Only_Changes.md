# DVDTransferManager — Agent-Only Access Changes

This document lists **every change** we made to the T-REX `DVDTransferManager.sol` to restrict
`initiateDVDTransfer` and `takeDVDTransfer` to TREX agents only.
Only **1 file** is modified: `contracts/DVD/DVDTransferManager.sol`.

---

## Why this change?

In the original T-REX design, `DVDTransferManager` was a **general-purpose peer-to-peer swap** contract.
Anyone could initiate a trade, and the counterpart (investor) could accept it directly on-chain.

In our SCO Bond platform, the flow is different:
- The **B&D Agent** manages the entire settlement process on-chain
- The **Investor** only gives ERC-20 approval (`cash.approve`) — they never call the DVD contract directly
- The investor's consent happens at the **application layer** (UI button click), not at the smart contract layer
- The backend (Java/Spring Boot + Web3j) executes both `initiateDVDTransfer` and `takeDVDTransfer` using the agent's wallet

This gives us a **managed institutional flow** where the agent drives settlement end-to-end.

---

## Change 1: Restrict `initiateDVDTransfer` to agents only — Line 247

```solidity
// ❌ BEFORE (original — anyone can call):

function initiateDVDTransfer(
    address _token1,
    uint256 _token1Amount,
    address _counterpart,
    address _token2,
    uint256 _token2Amount) external {
    require(IERC20(_token1).balanceOf(msg.sender) >= _token1Amount, "Not enough tokens in balance");
```

```solidity
// ✅ AFTER (our version — agents only):

function initiateDVDTransfer(
    address _token1,
    uint256 _token1Amount,
    address _counterpart,
    address _token2,
    uint256 _token2Amount) external {
    require(
        isTREXAgent(_token1, msg.sender) ||
        isTREXAgent(_token2, msg.sender)
        , "only TREX agents can initiate transfers");
    require(IERC20(_token1).balanceOf(msg.sender) >= _token1Amount, "Not enough tokens in balance");
```

**Why?**
The original contract had **no access control** on `initiateDVDTransfer`. Any wallet with tokens and allowance
could create a trade offer. This was fine for peer-to-peer swaps, but in our platform:
- Only the B&D Agent should create trade offers
- Investors should not be able to initiate trades on their own
- The agent is already registered as a TREX agent on the bond token (set during `deployTREXSuite`)

The new `require` checks that `msg.sender` is a TREX agent on either token in the trade.
If not, the transaction reverts with `"only TREX agents can initiate transfers"`.

---

## Change 2: Remove counterpart access from `takeDVDTransfer` — Line 314

```solidity
// ❌ BEFORE (original — counterpart OR agent can call):

require (
    msg.sender == token2.counterpart ||
    isTREXAgent(token1.token, msg.sender) ||
    isTREXAgent(token2.token, msg.sender)
    , "transfer has to be done by the counterpart or by owner");
```

```solidity
// ✅ AFTER (our version — agents only):

require (
    isTREXAgent(token1.token, msg.sender) ||
    isTREXAgent(token2.token, msg.sender)
    , "only TREX agents can execute transfers");
```

**Why?**
The original contract allowed **three** callers for `takeDVDTransfer`:
1. `msg.sender == token2.counterpart` — the investor themselves (peer-to-peer flow)
2. `isTREXAgent(token1.token, msg.sender)` — agent on the bond token side
3. `isTREXAgent(token2.token, msg.sender)` — agent on the cash token side

We removed option 1. In our platform, the investor never calls this function directly.
The B&D Agent calls it after the investor gives consent through the UI.

The investor's only on-chain action is `cash.approve(dvdAddress, amount)` — done once during onboarding.
Everything else is handled by the agent.

---

## What stays untouched (and why)

### `cancelDVDTransfer` — stays unchanged

```solidity
require (
    msg.sender == token2.counterpart ||
    msg.sender == token1.counterpart ||
    msg.sender == owner() ||
    isTREXAgent(token1.token, msg.sender) ||
    isTREXAgent(token2.token, msg.sender)
    , "you are not allowed to cancel this transfer");
```

We keep the original access control here. Cancellation is a **safety valve** — if something goes wrong,
either party, the contract owner, or an agent should be able to cancel. Restricting this would
reduce safety without any benefit.

### All other functions — stay unchanged

`modifyFee`, `calculateFee`, `calculateParity`, `calculateTransferID`, `isTREX`, `isTREXAgent`,
`isTREXOwner` — all unchanged. These are utility/view functions with their own access controls already.

---

## Summary table

| # | What we changed | Lines | Action |
|---|---|---|---|
| 1 | `initiateDVDTransfer` — added agent check | 247 | Added `require(isTREXAgent)` before balance check |
| 2 | `takeDVDTransfer` — removed counterpart access | 314–317 | Removed `msg.sender == token2.counterpart` condition |

**Total: 2 changes in 1 file.**

---

## Updated flow after changes

```
BEFORE (original T-REX):
  Anyone        → initiateDVDTransfer()  → creates offer
  Counterpart   → takeDVDTransfer()      → executes swap
  OR Agent      → takeDVDTransfer()      → executes swap

AFTER (our SCO Bond platform):
  Agent only    → initiateDVDTransfer()  → creates offer
  Agent only    → takeDVDTransfer()      → executes swap
  Investor      → cash.approve()         → one-time allowance (during onboarding)
```

---

## How the settlement works now

```
B&D Agent (backend)                     Investor (UI only)
      │                                       │
      │                                       │  1. Investor funded with EURd
      │                                       │  2. Investor approves DVD for cash
      │                                       │     (cash.approve — done once)
      │                                       │
      │  3. initiateDVDTransfer()             │
      │     (agent creates offer on-chain)    │
      │                                       │
      │  4. takeDVDTransfer(transferID)        │
      │     (agent executes the swap)         │
      │                                       │
      │     bonds: Agent → Investor ────────▶ │  Investor receives bonds
      │     cash: Investor → Agent  ◀──────── │  Cash pulled via allowance
      │                                       │
```

The investor never signs a DVD transaction. They only interact with the platform's UI.
The agent handles all on-chain settlement.
