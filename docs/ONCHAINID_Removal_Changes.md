# ONCHAINID Removal — All Contract Changes

This document lists **every change** we make to the T-REX codebase to remove ONCHAINID.
Only **2 files** are modified. Every other T-REX contract stays exactly as-is.

---

## File 1: `contracts/factory/TREXFactory.sol`

### Change 1: Remove the ONCHAINID import — Line 79

```solidity
// ❌ REMOVE this line:

import "@onchain-id/solidity/contracts/factory/IIdFactory.sol";
```

**Why?**
This imports the ONCHAINID factory interface — a separate npm package (`@onchain-id/solidity`).
Since we are not creating any ONCHAINID contracts, we don't need this import.
Without removing it, the code won't even compile because we won't install that dependency.

---

### Change 2: Remove the `_idFactory` storage variable — Lines 87–88

```solidity
// ❌ REMOVE these lines:

/// the address of the Identity Factory used to deploy token OIDs
address private _idFactory;
```

**Why?**
This variable stored the address of the ONCHAINID factory contract on-chain.
The ONCHAINID factory was a separate deployed contract that could mint new identity contracts.
Since we are not deploying any ONCHAINID identities, there is no factory address to store.

---

### Change 3: Simplify the constructor — Lines 93–97

```solidity
// ❌ BEFORE (original):

/// constructor is setting the implementation authority and the Identity Factory of the TREX factory
constructor(address implementationAuthority_, address idFactory_) {
    setImplementationAuthority(implementationAuthority_);
    setIdFactory(idFactory_);
}
```

```solidity
// ✅ AFTER (our version):

/// constructor is setting the implementation authority of the TREX factory
constructor(address implementationAuthority_) {
    setImplementationAuthority(implementationAuthority_);
}
```

**Why?**
The constructor originally took two addresses:
1. `implementationAuthority_` — the registry of implementation contracts (we keep this)
2. `idFactory_` — the ONCHAINID factory address (we remove this)

Now it only takes one parameter.
When we deploy, we call `new TREXFactory(ia)` instead of `new TREXFactory(ia, idFactory)`.

---

### Change 4: Remove the ONCHAINID auto-creation block — Lines 144–147

```solidity
// ❌ REMOVE these lines (inside the deployTREXSuite function):

if(_tokenDetails.ONCHAINID == address(0)) {
    address _tokenID = IIdFactory(_idFactory).createTokenIdentity(address(token), _tokenDetails.owner, _salt);
    token.setOnchainID(_tokenID);
}
```

**Why?**
This is the **most important change**. Here's what the original code did:
- When you call `deployTREXSuite` and pass `ONCHAINID = address(0)` (meaning "I don't have an identity yet")...
- The factory automatically calls the IdFactory to create a brand new ONCHAINID identity contract for the token
- It then calls `token.setOnchainID(newIdentity)` to link the token to that identity

We remove this because:
- We don't want any ONCHAINID contracts at all
- We pass `ONCHAINID = address(0)` **on purpose** — it means "no identity"
- The token will have its `onchainID` set to `address(0)`, which is perfectly fine
- Nothing in the transfer flow (isVerified, canTransfer, etc.) checks the token's own identity
- The token's identity was only used for things like claiming ownership via ERC-734/735 — we don't need that

---

### Change 5: Remove the `getIdFactory()` function — Lines 193–198

```solidity
// ❌ REMOVE these lines:

/**
 *  @dev See {ITREXFactory-getIdFactory}.
 */
function getIdFactory() external override view returns(address) {
    return _idFactory;
}
```

**Why?**
This was a read-only getter function to check what IdFactory address was stored.
Since we removed the `_idFactory` variable in Change 2, this function has nothing to return.
It also won't compile without the variable.

---

### Change 6: Remove the `setIdFactory()` function — Lines 225–232

```solidity
// ❌ REMOVE these lines:

/**
 *  @dev See {ITREXFactory-setIdFactory}.
 */
function setIdFactory(address idFactory_) public override onlyOwner {
    require(idFactory_ != address(0), "invalid argument - zero address");
    _idFactory = idFactory_;
    emit IdFactorySet(idFactory_);
}
```

**Why?**
This was a setter function that let the owner update the IdFactory address after deployment.
Same reason as Change 5 — the `_idFactory` variable doesn't exist anymore, and we never need to set an ONCHAINID factory address.

---

## File 2: `contracts/factory/ITREXFactory.sol`

The interface file must match the implementation. We remove the declarations for everything we removed above.

### Change 7a: Remove the `IdFactorySet` event — Line 110

```solidity
// ❌ REMOVE this line:

/// event emitted when the Identity Factory is set
event IdFactorySet(address _idFactory);
```

**Why?**
The `setIdFactory` function used to emit this event when the IdFactory address was changed.
Since `setIdFactory` is gone, this event is never emitted. Keeping it would just be dead code.

---

### Change 7b: Remove the `setIdFactory()` function declaration — Lines 133–141

```solidity
// ❌ REMOVE these lines:

/**
 *  @dev setter for identity factory contract address
 *  the identity factory contract is used by the TREX Factory to deploy the ONCHAINID
 *  of the token in case the ONCHAINID is not specified
 *  Only owner can call.
 *  emits `IdFactorySet` event
 *  @param _idFactory The address of the identity factory contract
 */
function setIdFactory(address _idFactory) external;
```

**Why?**
The interface declares what functions the contract must have.
Since `setIdFactory` no longer exists in TREXFactory.sol, we must remove its declaration here too.
If we don't, the compiler will complain that TREXFactory doesn't implement all interface functions.

---

### Change 7c: Remove the `getIdFactory()` function declaration — Lines 183–186

```solidity
// ❌ REMOVE these lines:

/**
 *  @dev getter for identity factory address
 */
function getIdFactory() external view returns(address);
```

**Why?**
Same as 7b — the function no longer exists in the implementation, so the interface declaration must go too.

---

## Summary table

| # | What we remove/change | File | Lines | Action |
|---|---|---|---|---|
| 1 | `import IIdFactory` | TREXFactory.sol | 79 | Delete line |
| 2 | `address private _idFactory` | TREXFactory.sol | 87–88 | Delete 2 lines |
| 3 | Constructor `idFactory_` parameter | TREXFactory.sol | 93–97 | Simplify (remove 2nd param + setIdFactory call) |
| 4 | ONCHAINID auto-creation `if` block | TREXFactory.sol | 144–147 | Delete 4 lines |
| 5 | `getIdFactory()` function | TREXFactory.sol | 193–198 | Delete 6 lines |
| 6 | `setIdFactory()` function | TREXFactory.sol | 225–232 | Delete 8 lines |
| 7a | `IdFactorySet` event | ITREXFactory.sol | 110 | Delete 1 line |
| 7b | `setIdFactory()` declaration | ITREXFactory.sol | 133–141 | Delete 9 lines |
| 7c | `getIdFactory()` declaration | ITREXFactory.sol | 183–186 | Delete 4 lines |

**Total: ~30 lines removed across 2 files.**

---

## What stays untouched (and why)

### The `ONCHAINID` field in TokenDetails struct — stays

```solidity
// This stays in ITREXFactory.sol line 83:
address ONCHAINID;
```

We keep this field in the struct. We just pass `address(0)` when calling `deployTREXSuite`.
The Token contract's `initialize()` function expects this parameter in the proxy constructor.
Rather than also modifying Token.sol and TokenProxy.sol, we simply pass zero.
The token stores it as `address(0)` but nothing ever reads it during transfers.
**Fewer changes = less risk of breaking something.**

### Token.sol — stays unchanged

The Token contract still has a `setOnchainID()` function and an `onchainID` field.
We just never call `setOnchainID()`. The field sits at `address(0)`. No harm done.

### IdentityRegistry.sol — stays unchanged

The `isVerified()` function still runs the full T-REX logic:
1. Check if wallet is in IdentityRegistryStorage → if no, return false
2. Check if ClaimTopicsRegistry has any required topics → if no topics, return **true** (this is our shortcut)
3. Check claims against TrustedIssuersRegistry → never reached for us

Since we deploy ClaimTopicsRegistry empty (no topics), step 2 always returns true.
The identity system becomes a pure whitelist without changing a single line.

### IdentityRegistryStorage.sol — stays unchanged

In full ERC-3643, it stores `wallet → ONCHAINID address`.
In our design, it stores `wallet → wallet itself` (the wallet's "identity" is its own address).
The contract doesn't care what address you store as the identity — it just needs it to be non-zero.
Storing the wallet's own address satisfies this.

### All other contracts — stay unchanged

Proxies, modules, DVDTransferManager, TREXGateway, TREXImplementationAuthority,
roles, compliance — everything else is used as-is from the official T-REX repo.
