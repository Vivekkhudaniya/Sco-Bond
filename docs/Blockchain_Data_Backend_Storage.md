# Storing Blockchain Data in the Backend

How to sync on-chain ERC-3643 event data into a backend database for the SCO Bond project.

---

## Three Approaches

### Approach 1: Custom Event Listener (Java/Spring Boot + web3j + PostgreSQL)

Best fit for this project since the backend is Java-based.

**How it works:**
- Use **web3j** to subscribe to contract events via WebSocket/RPC
- Parse events (Transfer, Mint, AddressFrozen, TREXSuiteDeployed, etc.)
- Write structured rows into **PostgreSQL**

**Architecture:**

```
Polygon Amoy Node (RPC/WebSocket)
        |
        v
  Event Listener Service (Spring Boot + web3j)
        |
        |-- Subscribe to contract events (via generated Java wrappers)
        |-- Decode event logs into typed objects
        |-- Handle reorgs (track block confirmations before finalizing)
        |
        v
  PostgreSQL
        |-- deployments (contract addresses, deal metadata)
        |-- transfers (from, to, amount, tx_hash, block_number)
        |-- whitelist_events (wallet, identity, country, action)
        |-- compliance_events (module, action)
        |-- dvd_transfers (transfer_id, status, bond_amount, cash_amount)
        +-- block_cursor (last_processed_block for restart/replay)
```

**Pros:** Full control, fits Java ecosystem, no external dependencies, SQL queries for reporting  
**Cons:** You own reorg handling, backfill logic, monitoring, and infra

---

### Approach 2: Indexer Framework (Envio, Ponder, or The Graph)

Best fit if you want fast setup and don't mind TypeScript tooling.

| Indexer | Language | Speed | Notes |
|---|---|---|---|
| **Envio** | TypeScript | Fastest (benchmarks claim 15x over competitors) | HyperSync, 80+ chains, local dev mode |
| **Ponder** | TypeScript | ~100x faster than The Graph | Self-hosted, good DX, hot reload |
| **The Graph** | AssemblyScript | Slowest | Decentralized network, hosted service shut down Feb 2026 |

**How it works:**
- Define event handlers in code (maps events to database rows)
- The framework handles RPC polling, decoding, reorgs, backfills
- Exposes a **GraphQL API** your backend queries

**Pros:** Reorg handling built-in, fast backfills, less code to write  
**Cons:** Adds TypeScript to your stack, another service to run, less control over schema

---

### Approach 3: Hybrid (Recommended for PoV)

Combine both: use a **lightweight event listener** in the Java backend for real-time needs, and store everything in PostgreSQL.

---

## What to Store for SCO Bond

| Table | Events to Capture | Why |
|---|---|---|
| `deal_deployments` | `TREXSuiteDeployed` | Track all contract addresses per deal |
| `token_transfers` | `Transfer` | Bond movement history |
| `token_mints` | `Transfer` (from=0x0) | Issuance records |
| `whitelist_entries` | `IdentityRegistered`, `IdentityRemoved` | Know who's approved |
| `compliance_events` | `ModuleAdded`, supply limit changes | Audit trail |
| `dvd_transfers` | `DVDTransferInitiated`, `DVDTransferExecuted` | Settlement status |
| `token_state` | `Paused`, `Unpaused`, `AddressFrozen` | Current token state |
| `sync_status` | -- | Block cursor + health check |

---

## PostgreSQL Schema Design Tips

- **Partition event tables** by `block_number` range (chain data grows fast)
- **Use JSONB column** for raw event data alongside typed columns
- **Index on** `(contract_address, block_number)` and `(tx_hash, log_index)`
- **Keep a `sync_status` table** tracking last indexed block per contract
- **Read-only event tables** -- no UPDATE or DELETE on chain data; append-only log
- **Store `tx_hash` as reference** -- always link back to the on-chain transaction

---

## Key Design Rules

1. **Idempotent writes** -- use `ON CONFLICT DO NOTHING` keyed on `(tx_hash, log_index)` so replaying events is safe
2. **Block cursor** -- store the last processed block so the service can resume after a crash
3. **Confirmation delay** -- wait N blocks before marking data as final (handles reorgs on Polygon)
4. **Separate chain data from app data** -- chain tables are an immutable event log; app tables derive state from them
5. **Don't put private data on-chain** -- store hashes/commitments on-chain, keep raw data in the database with access control

---

## Recommended Approach for This Project

Given that this is a **Java PoV on Polygon Amoy**:

1. **Start with web3j event listeners in Spring Boot** -- already in Java, testnet PoV doesn't need indexer scale
2. **PostgreSQL** as the store -- simple, relational, great for reporting
3. **Generate Java wrappers** from compiled ABIs (`out/` folder) using web3j CLI
4. **Build idempotent event handlers** with a block cursor for crash recovery
5. **Consider Envio or Ponder later** if moving to production and needing multi-chain or faster backfills

---

## References

- [Best Blockchain Indexers in 2026 - Envio](https://docs.envio.dev/blog/best-blockchain-indexers-2026)
- [Best Blockchain Indexers in 2026 - Ormi Labs](https://blog.ormilabs.com/best-blockchain-indexers-in-2025-real-time-web3-data-and-subgraph-platforms-compared/)
- [Blockchain Indexer Build vs Buy - Alchemy](https://www.alchemy.com/overviews/blockchain-indexer)
- [PostgreSQL and Blockchain Data - Reintech](https://reintech.io/blog/postgresql-and-blockchain-storing-data)
- [Introduction to Blockchain with Java, web3j, Spring Boot](https://piotrminkowski.com/2018/06/22/introduction-to-blockchain-with-java-using-ethereum-web3j-and-spring-boot/)
- [Envio vs The Graph](https://docs.envio.dev/blog/envio-vs-the-graph)
- [Ponder](https://ponder.sh)
- [Blockchain Indexers Compared - Spark](https://www.spark.money/tools/blockchain-indexer-comparison)
- [Building Regulated RWA Platform with ERC-3643 + Spring Boot](https://dev.to/ranjan_singh_devto/building-a-regulated-rwa-asset-tokenization-platform-with-erc-3643-polygon-spring-boot-grpc--l35)
- [How to Architect a Security Token Issuance Platform - ChainScore](https://www.chainscorelabs.com/guides/security-tokens-and-regulatory-compliance/security-token-lifecycle/how-to-architect-a-security-token-issuance-platform)
