# snapshot — Program Reference

Program ID: `hgUtrpstViwxutrkoVXwQh3GQC18wHAmuAvYFTNiV2M`

Records point-in-time values for a mint — its total supply and every holder's balance — indexed by a monotonically-increasing snapshot id. Enables reconstructing balances at past snapshots (e.g. coupon record dates) without storing per-transfer history.

Snapshots are taken exclusively by `coupon::create_coupon`, which CPIs `take_snapshot` signed by its `coupon_authority` PDA. Three other callers append entries to the running histories whenever they move tokens (so long as a snapshot is active): `mint_authority` (mint), `permanent_delegate` (operations), and `transfer_hook_authority` (transfer-hook).

---

## State

### `SnapshotCounter`

```rust
#[account]
pub struct SnapshotCounter {
    pub bump: u8,
    pub count: u64,
}
// LEN = 8 + 1 + 8 = 17 bytes
// Seeds: ["snapshot_counter", mint]
```

Holds the id of the **next** snapshot (a 0-based, strictly-increasing counter). Created by `take_snapshot` on its first call with `count = 0`, which is then used as the first snapshot id and immediately incremented to `1`; each subsequent call uses the current `count` as the snapshot id and increments it. So after N snapshots, `count == N`, and the last-taken snapshot id is `count - 1`. When the PDA does not exist, no snapshot has been taken yet and all `update_*_snapshot` CPIs exit silently.

Storing the *next* id (rather than the last) is deliberate: it lets `snapshot_merkle_root` be created with Anchor's `#[account(init)]`, whose seed reads `snapshot_counter.count` at account resolution (see `take_snapshot`).

### `SnapshotMerkleRoot`

```rust
#[account]
pub struct SnapshotMerkleRoot {
    pub bump: u8,
    pub merkle_root: [u8; 32],
}
// LEN = 8 + 1 + 32 = 41 bytes
// Seeds: ["snapshot_merkle_root", mint, snapshot_id.to_le_bytes()]
```

One **immutable** commitment per snapshot. Created by `take_snapshot` with the caller-supplied 32-byte root of the off-chain Sorted-pair Merkle tree whose leaves are `(account, balance)` pairs at that snapshot. Created via Anchor's `#[account(init)]` keyed by the snapshot id, so it can be created only once per id — the root can never be rewritten — and Anchor transparently handles an attacker having pre-funded the (predictable) PDA address.

### `SnapshotEntry`

```rust
pub struct SnapshotEntry { pub key: u64, pub value: u64 }
// 16 bytes
```

### `SnapshotHistory`

```rust
#[account]
pub struct SnapshotHistory {
    pub bump: u8,
    pub entries: Vec<SnapshotEntry>,
}
// BASE_LEN = 8 + 1 + 4 = 13 bytes; len_for(n) = 13 + n * 16
```

Stores the full `(snapshot_id, value)` history for one subject:

| Seeds | Subject |
|---|---|
| `["snapshot_totalsupply", mint]` | mint total supply |
| `["snapshot_holderbalance", mint, token_account]` | one holder's balance |

Entries are always appended with a strictly-increasing `key`. `SnapshotHistory::lookup_at_or_above(key)` returns the value stored at that key, or — if the exact key is missing — the value of the next-higher key (binary search on the sorted entries).

---

## Error Codes

```rust
pub enum ErrorCode {
    Unauthorized,             // calling_authority not in the allowed set
    InvalidTokenAccount,      // holder_token_account.mint does not match the mint arg
    DeltaOverflow,            // balance ± delta would overflow/underflow u64
    SnapshotCounterOverflow,  // counter at u64::MAX when taking a new snapshot
}
```

---

## Instruction: `take_snapshot` (Auxiliary)

### Parameters

```rust
merkle_root: [u8; 32]
```

`snapshot_counter` stores the id of the **next** snapshot (see the State section). The snapshot id assigned is the counter's *current* value (`0` for the very first snapshot); the counter is created (`init_if_needed`, `count = 0`) if needed and incremented by one afterwards.

Because the snapshot id equals `snapshot_counter.count` — a value that already exists at account resolution — the `snapshot_merkle_root` PDA is created with Anchor's **`#[account(init)]`**, whose `seeds = ["snapshot_merkle_root", mint, snapshot_counter.count.to_le_bytes()]` are resolved before the handler runs. The handler then just writes `{ bump, merkle_root }`. This means:

- **Immutability**: `init` fails if the account already exists, so a given snapshot id's root can never be overwritten.
- **No prefunding DoS**: Anchor's `init` internally handles a pre-funded destination (it falls back to `transfer` + `allocate` + `assign` instead of a bare `create_account`), so an attacker cannot brick snapshot creation by sending 1 lamport to the predictable PDA address.

(An earlier iteration created the PDA manually because the id was computed as `counter + 1` inside the handler; switching the counter to store the *next* id removed the need for manual creation.)

### Authorization

`calling_authority` must be the `coupon_authority` PDA owned by `coupon` (seeds: `["coupon_authority", mint]`). Only `coupon::create_coupon` can produce that signature via `invoke_signed`, so every snapshot in the workspace is anchored to a coupon.

Role (`ROLE_CORPORATE_ACTION`) / functionality (`COUPON_CREATE_COUPON`) / pause / deactivate checks live in `coupon::create_coupon` — `take_snapshot` itself trusts its caller, matching the style of the other auxiliaries (`update_totalsupply_snapshot`, `update_holderbalance_snapshot`).

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `calling_authority` | no | yes | Signer | `coupon_authority` PDA owned by `coupon` |
| `payer` | yes | yes | Signer | Funds the `snapshot_counter` PDA on the first call. Distinct from `calling_authority` because PDAs cannot pay rent. |
| `mint` | no | no | UncheckedAccount | Used as the seed for the `coupon_authority` PDA derivation |
| `snapshot_counter` | yes | no | `Account<SnapshotCounter>` | `init_if_needed`; seeds `["snapshot_counter", mint]`; holds the next snapshot id |
| `snapshot_merkle_root` | yes | no | `Account<SnapshotMerkleRoot>` | `init`; seeds `["snapshot_merkle_root", mint, snapshot_counter.count]` — Anchor creates it (id read from the counter at resolution) |
| `system_program` | no | no | Program<System> | |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `SnapshotTriggered` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI |

### Events

| Event | Fields | Emitted |
|---|---|---|
| `SnapshotTriggered` | `mint: Pubkey`, `snapshot_id: u64`, `merkle_root: [u8; 32]` | After the counter is created/incremented and the root PDA is written, with `snapshot_id` set to the new `count` |

Emitted with `emit_cpi!` (not `emit!`), which records the event as a self-CPI captured in the transaction's `innerInstructions` rather than in program logs — avoiding log-truncation loss for off-chain indexers. This requires `#[event_cpi]` on `TakeSnapshot` (injecting the `event_authority` and `program` accounts above) and the `event-cpi` feature on `anchor-lang` in `Cargo.toml`. Because these events live in inner instructions, Anchor's log-based `program.addEventListener` cannot see them; the test suite decodes them from `innerInstructions` instead (see `tests/program_helpers/event_helper.ts`).

---

## Instruction: `update_totalsupply_snapshot` (Auxiliary)

No parameters.

Appends `(current_snapshot_id, mint.supply)` to `total_supply_snapshot`, where `current_snapshot_id = snapshot_counter.count - 1` (the last-taken snapshot, since the counter stores the *next* id). Creates the PDA on first use, grows it by one entry otherwise. Silently succeeds when `snapshot_counter` does not exist (no active snapshot).

### Authorization

`calling_authority` must be either:
- `["mint_authority", mint]` owned by `mint`, or
- `["permanent_delegate", mint]` owned by `operations`.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `calling_authority` | no | yes | Signer | One of the two allowed PDAs |
| `payer` | yes | yes | Signer | Funds PDA creation / realloc |
| `mint` | no | no | UncheckedAccount | Current supply read via `StateWithExtensions` |
| `snapshot_counter` | no | no | UncheckedAccount | seeds `["snapshot_counter", mint]`; may be empty |
| `total_supply_snapshot` | yes | no | UncheckedAccount | seeds `["snapshot_totalsupply", mint]` |
| `system_program` | no | no | Program<System> | |

---

## Instruction: `update_holderbalance_snapshot` (Auxiliary)

### Parameters

```rust
delta:    u64
increase: bool
```

Records `(current_snapshot_id, balance ± delta)` for the given `holder_token_account`, where `current_snapshot_id = snapshot_counter.count - 1` (the last-taken snapshot, since the counter stores the *next* id). With `increase = true` the recorded value is `balance + delta`; otherwise `balance - delta`. Callers that want to capture a balance as it was *before* a token movement that has already been applied (e.g. the transfer hook, which runs after the debit) pass the moved amount to reconstruct the pre-movement value. Callers that record the on-chain balance as-is pass `delta = 0`.

Same "silent no-op when no snapshot is active" semantics as the total-supply variant.

### Authorization

`calling_authority` must be one of:
- `["mint_authority", mint]` (mint)
- `["permanent_delegate", mint]` (operations)
- `["transfer_hook_authority", mint]` (transfer-hook)

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `calling_authority` | no | yes | Signer | One of the three allowed PDAs |
| `payer` | yes | yes | Signer | Funds PDA creation / realloc |
| `mint` | no | no | UncheckedAccount | |
| `snapshot_counter` | no | no | UncheckedAccount | seeds `["snapshot_counter", mint]`; may be empty |
| `holder_balance_snapshot` | yes | no | UncheckedAccount | seeds `["snapshot_holderbalance", mint, holder_token_account]` |
| `holder_token_account` | no | no | UncheckedAccount | Token-2022 account; its `amount` is the reference balance |
| `system_program` | no | no | Program<System> | |

---

## Instructions: `get_totalsupply_snapshot_at`, `get_holderbalance_snapshot_at` (View)

### Parameters

```rust
snapshot_id: u64
```

Return `u64`. Both are called via `.view()` from the client — they only read state.

For a requested `snapshot_id`, the handler does `lookup_at_or_above(snapshot_id)` on the history:
- If an entry at that id exists, returns its value.
- Otherwise returns the next-higher recorded value (the holder or mint didn't move between that snapshot and the next one — the later value still reflects the requested id's state).
- If no entry has been recorded at or above the id, falls back to the current on-chain value (mint supply / token-account balance). For a holder whose token account does not exist yet, returns `0`.

### Accounts

`get_totalsupply_snapshot_at`: `mint`, `total_supply_snapshot`.
`get_holderbalance_snapshot_at`: `mint`, `holder_balance_snapshot`, `holder_token_account`.

Both PDAs are seed-checked; either may be empty (triggering the current-value fallback).

---

## Program IDs

All program IDs come from `common::program_ids`. In `lib.rs` the relevant IDs are imported directly by name — no per-program `constants.rs` exists:

```rust
use common::program_ids::{COUPON_PROGRAM_ID, MINT_PROGRAM_ID, OPERATIONS_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID};
```

These are used in `assert_authorized_caller` and related functions inside `lib.rs`. Instructions that need IDs use `use common::program_ids as constants;` locally.
