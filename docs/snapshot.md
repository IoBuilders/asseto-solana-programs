# snapshot — Program Reference

Program ID: `hgUtrpstViwxutrkoVXwQh3GQC18wHAmuAvYFTNiV2M`

Records an immutable Merkle-root commitment for a mint at a point in time, indexed by a monotonically-increasing snapshot id. A holder's balance at a given snapshot is proven against that snapshot's root via an off-chain Merkle proof, rather than by reading any on-chain per-holder history.

Snapshots are taken exclusively by `coupon::create_coupon`, which CPIs `take_snapshot` signed by its `coupon_authority` PDA.

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

---

## Error Codes

```rust
pub enum ErrorCode {
    Unauthorized,             // calling_authority not in the allowed set
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

Role (`ROLE_CORPORATE_ACTION`) / functionality (`COUPON_CREATE_COUPON`) / pause / deactivate checks live in `coupon::create_coupon` — `take_snapshot` itself trusts its caller.

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

## Program IDs

All program IDs come from `common::program_ids`. In `lib.rs` the relevant ID is imported directly by name — no per-program `constants.rs` exists:

```rust
use common::program_ids::COUPON_PROGRAM_ID;
```

This is used in `assert_take_snapshot_authorized_caller` inside `lib.rs`. Instructions that need IDs use `use common::program_ids as constants;` locally.
