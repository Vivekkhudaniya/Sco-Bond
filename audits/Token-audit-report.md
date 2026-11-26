# Security Review — Token (ERC-3643 T-REX)

---

## Scope

|  |  |
| --- | --- |
| **Mode** | filename |
| **Files reviewed** | `contracts/token/Token.sol` · `contracts/token/TokenStorage.sol` · `contracts/token/IToken.sol`<br>`contracts/roles/AgentRoleUpgradeable.sol` · `contracts/roles/Roles.sol` |
| **Confidence threshold (1-100)** | 75 |

---

## Findings

[85] **1. `recoveryAddress` is non-functional with whitelist-trick identities**

`Token.recoveryAddress` · Confidence: 85

**Description**

The `recoveryAddress` function calls `IIdentity(_investorOnchainID).keyHasPurpose(_key, 1)` to verify that the new wallet belongs to the same investor. In our deployment, `registerIdentity` uses investor EOA addresses (not real ONCHAINID Identity contracts) as the identity parameter. Calling `keyHasPurpose` on an EOA reverts because EOAs have no contract code, making wallet recovery permanently unusable.

**Fix**

```diff
- IIdentity _onchainID = IIdentity(_investorOnchainID);
- bytes32 _key = keccak256(abi.encode(_newWallet));
- if (_onchainID.keyHasPurpose(_key, 1)) {
+ // In whitelist-trick mode (no real ONCHAINID), skip key verification
+ // and rely on agent authorization as the trust anchor.
+ {
      uint256 investorTokens = balanceOf(_lostWallet);
```

---

[80] **2. `forcedTransfer` bypasses compliance `canTransfer` check**

`Token.forcedTransfer` · Confidence: 80

**Description**

`forcedTransfer` calls `_tokenCompliance.transferred()` (notification) but skips `_tokenCompliance.canTransfer()` (validation). An agent can force-transfer tokens that would exceed the SupplyLimitModule cap or violate other compliance rules. While this is by T-REX design (agents override compliance), in the single-wallet SCO Bond architecture the same key that mints also force-transfers — a single compromised key bypasses all compliance rails.

**Fix**

```diff
  function forcedTransfer(
      address _from,
      address _to,
      uint256 _amount
  ) public override onlyAgent returns (bool) {
      require(balanceOf(_from) >= _amount, "sender balance too low");
+     require(_tokenCompliance.canTransfer(_from, _to, _amount), "Compliance not followed");
      uint256 freeBalance = balanceOf(_from) - (_frozenTokens[_from]);
```

---

[78] **3. Batch functions do not validate array-length parity**

`Token.batchTransfer` · Confidence: 78

**Description**

All seven batch functions (`batchTransfer`, `batchMint`, `batchBurn`, `batchForcedTransfer`, `batchSetAddressFrozen`, `batchFreezePartialTokens`, `batchUnfreezePartialTokens`) iterate over the first array and index into the second without checking that both arrays have the same length. If the arrays are mismatched, the transaction reverts with a generic Solidity panic (index out of bounds) after partial execution has already consumed gas. No funds are lost, but the error is uninformative and wastes gas.

**Fix**

```diff
  function batchTransfer(address[] calldata _toList, uint256[] calldata _amounts) external override {
+     require(_toList.length == _amounts.length, "array length mismatch");
      for (uint256 i = 0; i < _toList.length; i++) {
          transfer(_toList[i], _amounts[i]);
      }
  }
```

Apply the same `require` to all seven batch functions.

---

[76] **4. `setIdentityRegistry` accepts zero address**

`Token.setIdentityRegistry` · Confidence: 76

**Description**

`setIdentityRegistry` has no zero-address check. If the owner accidentally sets `_identityRegistry` to `address(0)`, every subsequent `transfer`, `transferFrom`, `mint`, and `forcedTransfer` will revert because `isVerified()` is called on the zero address. The token becomes non-transferable until the owner sets a valid registry. While recoverable, the disruption window is unbounded.

**Fix**

```diff
  function setIdentityRegistry(address _identityRegistry) public override onlyOwner {
+     require(_identityRegistry != address(0), "invalid argument - zero address");
      _tokenIdentityRegistry = IIdentityRegistry(_identityRegistry);
      emit IdentityRegistryAdded(_identityRegistry);
  }
```

---

Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | [85] | `recoveryAddress` is non-functional with whitelist-trick identities |
| 2 | [80] | `forcedTransfer` bypasses compliance `canTransfer` check |
| 3 | [78] | Batch functions do not validate array-length parity |
| 4 | [76] | `setIdentityRegistry` accepts zero address |

---

## Leads

_Vulnerability trails with concrete code smells where the full exploit path could not be completed in one analysis pass. These are not false positives — they are high-signal leads for manual review. Not scored._

- **ERC-20 approve race condition** — `Token.approve` — Code smells: no increaseAllowance/decreaseAllowance enforcement — The classic front-running vulnerability where a spender can double-spend during an allowance change. Mitigated by the existence of `increaseAllowance`/`decreaseAllowance`, but `approve` itself is not gated. In the SCO Bond flow, investor approval targets the DVDTransferManager only, limiting exposure.

- **No re-entrancy guard on compliance callbacks** — `Token.transfer`, `Token.transferFrom`, `Token.forcedTransfer` — Code smells: external call after state change without `nonReentrant` — All transfer paths make external calls to `_tokenCompliance.transferred()` after updating balances. The compliance module is a trusted contract set by the owner, and the checks-effects-interactions pattern is followed (state changes before external call), but a malicious or compromised compliance module could re-enter. The `onlyToken` modifier on ModularCompliance limits this surface.

- **`burn` has no pause or freeze guard** — `Token.burn` — Code smells: missing `whenNotPaused` modifier — By design, `burn` works when paused and when the target address is frozen (it auto-unfreezes if needed). This is intentional for the redemption flow, but if the agent key is compromised, an attacker can burn investor tokens even when the token is emergency-paused. The same key controls pause and burn, so this is a single-point-of-failure issue inherent to the single-wallet architecture.

- **`transfer` does not check `isVerified(msg.sender)`** — `Token.transfer` — Code smells: asymmetric verification — Only the receiver is verified against the Identity Registry. A de-whitelisted sender can still transfer tokens out. This is by ERC-3643 design (the sender was verified at mint time), but it means removing an investor from the whitelist does not immediately freeze their outbound transfers — use `setAddressFrozen` for that.

---

## Privileged Roles

| Role | Address | Powers |
|---|---|---|
| **Owner** (platformAdmin) | Single admin wallet | setName, setSymbol, setOnchainID, setIdentityRegistry, setCompliance, addAgent, removeAgent, transferOwnership |
| **Agent** (bndSafe = same wallet) | Single admin wallet | mint, burn, pause, unpause, forcedTransfer, setAddressFrozen, freezePartialTokens, unfreezePartialTokens, recoveryAddress |

> **Single-wallet risk:** Both owner and agent are the same private key. A single compromise grants full control over token supply, compliance, registry, and investor balances.

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended.
