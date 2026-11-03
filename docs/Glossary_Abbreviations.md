# Glossary — All Abbreviations and Terms

Every abbreviation and term used across the SCO Bond ERC-3643 project.

---

## Contract Abbreviations

| Abbreviation | Full Name | What it does (one line) |
|---|---|---|
| **IA** | **TREXImplementationAuthority** | The code library — stores where the 6 implementation contracts live so proxies can find their code |
| **IR** | **IdentityRegistry** | The whitelist desk — answers "is this wallet allowed to receive bonds?" |
| **IRS** | **IdentityRegistryStorage** | The filing cabinet behind the desk — stores the actual wallet records (wallet → identity + country) |
| **CTR** | **ClaimTopicsRegistry** | The sign on the wall — lists what claims/stamps are required (empty in our design = no claims needed) |
| **TIR** | **TrustedIssuersRegistry** | The list of stamping offices — which issuers can sign claims (empty in our design = none needed) |
| **MC** | **ModularCompliance** | The rule book — checks every plugged-in module before allowing a transfer (e.g. supply limit) |

---

## Other Terms

| Term | Full Name | What it does |
|---|---|---|
| **DVD** | **Delivery vs Delivery** | The atomic swap contract — bonds and cash move in one transaction, or neither moves |
| **DVA** | **Delivery vs Approval** | Another swap contract (not used by us) — requires a chain of approvals before moving tokens |
| **TREX** | **Token for Regulated EXchanges** | The name of the whole ERC-3643 framework built by Tokeny |
| **ONCHAINID / OID** | **On-Chain Identity** | A separate identity contract per person/token (removed in our design) |
| **B&D** | **Bill & Deliver** (agent) | The entity that mints bonds and offers trades to investors |
| **EURd** | **Euro Digital** | Our test cash token (MockCashToken with 6 decimals) |
| **PoV** | **Proof of Value** | This testnet demo — proving the concept works before production |

---

## How they connect (using abbreviations)

```
Gateway → Factory → deploys per deal:
                      ├── Token proxy     (the bond)
                      ├── IR proxy        (the whitelist desk)
                      ├── IRS proxy       (the filing cabinet)
                      ├── CTR proxy       (required claims — empty)
                      ├── TIR proxy       (trusted issuers — empty)
                      └── MC proxy        (rule book with SupplyLimitModule)

All proxies → ask IA → "where is my actual code?"
```

---

## IA vs Gateway — The two most confused terms

| | TREXImplementationAuthority (IA) | TREXGateway |
|---|---|---|
| **What it is** | A code library / version registry | A security guard / access controller |
| **What it stores** | Addresses of the 6 implementation contracts | List of approved deployers |
| **Who talks to it** | Proxies (to find their code) | Platform Admin (to create deals) |
| **Who it talks to** | Nobody — it's just a lookup table | The Factory (calls `deployTREXSuite`) |
| **When it's used** | Every time any proxy function is called | Only when creating a new deal |
| **Can you skip it?** | No — proxies need it to find the code | Technically yes, but you lose access control |

**Gateway controls WHO can deploy. IA controls WHAT code the deployed proxies run.**
