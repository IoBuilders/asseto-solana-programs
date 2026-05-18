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

Holds the current snapshot id. Created by `take_snapshot` on its first call with `count = 1`; each subsequent call increments. When the PDA does not exist, no coupon has been created yet and all `update_*_snapshot` CPIs exit silently.

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
    Unauthorized,        // calling_authority not in the allowed set
    InvalidTokenAccount, // holder_token_account.mint does not match the mint arg
    DeltaOverflow,       // balance ± delta would overflow/underflow u64
}
```

---

## Instruction: `take_snapshot` (Auxiliary)

No parameters.

Creates `snapshot_counter` (`init_if_needed`) with `count = 1` on the first call, or increments the existing counter. The snapshot id is always `>= 1` whenever the counter PDA exists.

### Authorization

`calling_authority` must be the `coupon_authority` PDA owned by `coupon` (seeds: `["coupon_authority", mint]`). Only `coupon::create_coupon` can produce that signature via `invoke_signed`, so every snapshot in the workspace is anchored to a coupon.

Pause / deactivate / deployer checks live in `coupon::create_coupon` — `take_snapshot` itself trusts its caller, matching the style of the other auxiliaries (`update_totalsupply_snapshot`, `update_holderbalance_snapshot`).

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `calling_authority` | no | yes | Signer | `coupon_authority` PDA owned by `coupon` |
| `payer` | yes | yes | Signer | Funds the `snapshot_counter` PDA on the first call. Distinct from `calling_authority` because PDAs cannot pay rent. |
| `mint` | no | no | UncheckedAccount | Used as the seed for the `coupon_authority` PDA derivation |
| `snapshot_counter` | yes | no | `Account<SnapshotCounter>` | `init_if_needed`; seeds `["snapshot_counter", mint]` |
| `system_program` | no | no | Program<System> | |

---

## Instruction: `update_totalsupply_snapshot` (Auxiliary)

No parameters.

Appends `(current_snapshot_id, mint.supply)` to `total_supply_snapshot`. Creates the PDA on first use, grows it by one entry otherwise. Silently succeeds when `snapshot_counter` does not exist (no active snapshot).

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

Records `(current_snapshot_id, balance ± delta)` for the given `holder_token_account`. With `increase = true` the recorded value is `balance + delta`; otherwise `balance - delta`. Callers that want to capture a balance as it was *before* a token movement that has already been applied (e.g. the transfer hook, which runs after the debit) pass the moved amount to reconstruct the pre-movement value. Callers that record the on-chain balance as-is pass `delta = 0`.

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

## constants.rs

All program IDs are hardcoded — the CPI callers (`mint`, `operations`, `transfer-hook`, `coupon`) depend on `snapshot`, so importing any of them here would create a cycle.

```rust
pub const DEPLOY_PROGRAM_ID:        Pubkey = Pubkey::new_from_array([...]);
pub const DEACTIVATE_PROGRAM_ID:    Pubkey = Pubkey::new_from_array([...]);
pub const MINT_PROGRAM_ID:          Pubkey = Pubkey::new_from_array([...]);
pub const OPERATIONS_PROGRAM_ID:    Pubkey = Pubkey::new_from_array([...]);
pub const TRANSFER_PROGRAM_ID:      Pubkey = Pubkey::new_from_array([...]);
pub const TRANSFER_HOOK_PROGRAM_ID: Pubkey = Pubkey::new_from_array([...]);
pub const COUPON_PROGRAM_ID:        Pubkey = Pubkey::new_from_array([...]);
```
