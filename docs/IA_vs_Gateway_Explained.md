# TREXImplementationAuthority vs TREXGateway — Explained

These are **two different contracts** with very different jobs.

---

## TREXImplementationAuthority — "The code library"

**Purpose:** It's a **registry that stores the addresses of the 6 master implementation contracts** (Token, IdentityRegistry, IdentityRegistryStorage, ClaimTopicsRegistry, TrustedIssuersRegistry, ModularCompliance).

**Why it exists:** Every deal deploys 6 **proxy** contracts, not full contracts. A proxy is a lightweight shell that doesn't contain its own logic — instead, it asks the ImplementationAuthority: *"Where is the actual Token code I should run?"* and delegates all calls to that address.

```
Without ImplementationAuthority:
  Deal 1: deploys full Token (expensive gas)
  Deal 2: deploys full Token again (expensive gas)
  Deal 3: deploys full Token again (expensive gas)

With ImplementationAuthority:
  Once:   deploy Token implementation (full code)
  Once:   IA stores: "Token code lives at 0xABC..."
  Deal 1: deploys Token proxy → asks IA → runs code from 0xABC (cheap!)
  Deal 2: deploys Token proxy → asks IA → runs code from 0xABC (cheap!)
  Deal 3: deploys Token proxy → asks IA → runs code from 0xABC (cheap!)
```

**It also enables upgrades:** If you want to upgrade the Token code later, you update the IA to point to a new implementation. All existing proxies automatically start using the new code.

```
ImplementationAuthority says:
  version 1.0.0 → {Token: 0xABC, IR: 0xDEF, IRS: 0x123, CTR: 0x456, TIR: 0x789, MC: 0xAAA}

Every proxy asks the IA: "where is my code?" → IA replies with the address
```

---

## TREXGateway — "The front door / security guard"

**Purpose:** It's an **access control layer** that sits in front of the Factory. It decides **who is allowed to create new deals**.

**Why it exists:** The Factory's `deployTREXSuite` can only be called by its owner. The Gateway owns the Factory, so only the Gateway can call it. The Gateway then checks: "Is the person calling me an approved deployer?"

```
Without Gateway:
  Anyone who is Factory owner can deploy deals
  No access control, no fee system

With Gateway:
  Platform Admin → Gateway: "I want to deploy a deal"
  Gateway checks: "Are you an approved deployer?" → Yes → calls Factory
  Random person → Gateway: "I want to deploy" → "Not approved" → rejected
```

---

## Side by side

| | TREXImplementationAuthority | TREXGateway |
|---|---|---|
| **What it is** | A code library / version registry | A security guard / access controller |
| **What it stores** | Addresses of the 6 implementation contracts | List of approved deployers |
| **Who talks to it** | Proxies (to find their code) | Platform Admin (to create deals) |
| **Who it talks to** | Nobody — it's just a lookup table | The Factory (calls `deployTREXSuite`) |
| **When it's used** | Every time any proxy function is called | Only when creating a new deal |
| **Can you skip it?** | No — proxies need it to find the code | Technically yes, but you lose access control |

---

## The chain

```
Platform Admin
      │
      ▼
TREXGateway          ← "Are you allowed to deploy?" (access control)
      │
      ▼
TREXFactory          ← "Deploy 6 proxies for this deal" (the builder)
      │
      ▼
Each Proxy           ← "Where is my code?"
      │
      ▼
ImplementationAuthority  ← "Token code is at 0xABC, IR is at 0xDEF..." (the library)
      │
      ▼
Implementation contracts ← The actual code that runs
```

**So: Gateway controls WHO can deploy. ImplementationAuthority controls WHAT code the deployed proxies run.**
