# Token Standard

## Overview

The farmledge-protocol token standard defines the on-chain representation of a
physical agricultural warehouse receipt. Each token corresponds to a real-world
deposit at a licensed warehouse facility and carries structured metadata that
makes it inspectable, tradeable, and financeable without leaving the Stellar
network.

Tokens are issued per-commodity. The **maize-receipt** contract handles maize
deposits (commodity codes `MAIZE_WHITE` and `MAIZE_YELLOW`); the
**sesame-receipt** contract handles sesame deposits (commodity code `SESAME`).
The two contracts share the same metadata schema and lifecycle model.

---

## Token Metadata Fields

Each minted token stores a `TokenMetadata` struct on-chain with the following
fields:

| Field              | Type      | Description                                                         |
|--------------------|-----------|---------------------------------------------------------------------|
| `token_id`         | `String`  | Unique identifier in the format `<PREFIX>-YYYY-NNNNNN` (see below) |
| `commodity`        | `String`  | Commodity code, e.g. `MAIZE_WHITE`, `MAIZE_YELLOW`, or `SESAME`   |
| `grade`            | `String`  | Grade label assigned at inspection, e.g. `Grade A`                 |
| `bag_count`        | `u32`     | Number of physical bags in the deposit                             |
| `weight_per_bag_kg`| `u32`     | Weight of each bag in kilograms                                     |
| `total_weight_kg`  | `u32`     | Computed as `bag_count × weight_per_bag_kg`                        |
| `warehouse_id`     | `String`  | Identifier of the licensed warehouse holding the deposit            |
| `custodian`        | `Address` | On-chain address of the custodian who issued the token              |
| `deposit_ts`       | `u64`     | Unix timestamp (seconds) when the deposit was recorded on-chain    |
| `is_locked`        | `bool`    | Whether the token is locked for financing (prevents transfer/burn)  |
| `parent_token_id`  | `Option<String>` | Set when this token was produced by a `split()` operation   |

### Token ID Format

Token IDs follow the pattern `<PREFIX>-YYYY-NNNNNN`:

- **Maize** tokens: prefix `KN` → e.g. `KN-2026-000001`
- **Sesame** tokens: prefix `SN` → e.g. `SN-2026-000001`
- `YYYY` is the calendar year derived from the ledger timestamp at mint time
- `NNNNNN` is a zero-padded, per-contract monotonic counter

---

## Lifecycle

```
deploy → init(admin)
              │
              ▼
     add_custodian(admin, custodian)
              │
              ▼
 mint(custodian, farmer, commodity, grade, …) → token_id
              │
              ├─ transfer(token_id, from, to)   # change ownership
              │
              ├─ lock(admin, token_id)           # freeze for financing
              │        │
              │        └─ unlock(admin, token_id)
              │
              ├─ split(token_id, amount_kg)      # divide into two child tokens
              │    └─ produces child_a_id, child_b_id (same lifecycle)
              │
              └─ burn(custodian, token_id)        # redeem / withdraw goods
```

### State transitions

| State         | Allowed operations                            |
|---------------|-----------------------------------------------|
| Active        | `transfer`, `lock`, `split`, `burn`           |
| Locked        | `unlock` (admin only); transfer/burn rejected |
| Burned        | Terminal — token storage entries are removed  |

A burned token cannot be recovered. Locking is used by lenders to prevent
transfer while a financing facility is active.

---

## Compliance Requirements

1. **Commodity validation** — the contract enforces that `commodity` matches
   the contract's accepted list. Passing an invalid commodity code causes the
   `mint()` call to revert with `InvalidCommodity`.

2. **Custodian authorisation** — only addresses that have been registered via
   `add_custodian()` may call `mint()` and `burn()`. Calls from unregistered
   accounts revert with `Unauthorized`.

3. **Weight integrity** — `bag_count` and `weight_per_bag_kg` must both be
   greater than zero. `total_weight_kg` is computed by the contract (not
   supplied by the caller) to prevent manipulation.

4. **Split conservation** — `split()` guarantees that
   `child_a.total_weight_kg + child_b.total_weight_kg == parent.total_weight_kg`.
   The parent token is atomically burned when its children are minted.

5. **Lock semantics** — only the admin may lock or unlock a token. A locked
   token blocks `transfer`, `burn`, and `split` to protect lender collateral.

---

## Reference Implementation

| Component        | Path                                        |
|------------------|---------------------------------------------|
| Maize contract   | `contracts/maize-receipt/src/lib.rs`        |
| Sesame contract  | `contracts/sesame-receipt/src/lib.rs`       |
| Maize SDK        | `sdk/src/maize/`                            |
| Sesame SDK       | `sdk/src/sesame/`                           |
| TypeScript types | `sdk/src/types.ts`                          |
