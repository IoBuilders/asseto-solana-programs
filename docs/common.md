# common — Shared Library Reference

No program ID. No entrypoint. This is a Rust library crate imported by all other programs in the workspace.

All logic and types that are shared across programs live here. Adding a dependency from any program to `common` does not create a circular dependency because `common` has no dependencies on any program in this workspace.

---

## State: `AssetConfiguration`

```rust
// Uses #[derive(AnchorSerialize, AnchorDeserialize)] — NOT #[account]
// because #[account] requires declare_id!, which a library crate cannot have.
pub struct AssetConfiguration {
    pub asset_class_config_id: u64,   // asset-class PDA seed (1/2)
    pub asset_class_version_id: u64,  // asset-class PDA seed (2/2)
    pub bump: u8,
}
// LEN = 8 (discriminator) + 8 (asset_class_config_id) + 8 (asset_class_version_id) + 1 (bump) = 25 bytes
```

Defined here so downstream programs can deserialize `asset_configuration_pda` without importing `deploy`. `deploy` defines its own `#[account] AssetConfiguration` (with the same fields) so it can use `Account<AssetConfiguration>` in its accounts struct.

---

## State: `AssetClassVersion`

A **zero-copy** (`#[repr(C)]`, `Pod`, `Zeroable`) field-for-field mirror of `factory::state::AssetClassVersion` — see [`docs/factory.md`](factory.md) for the field meanings and how the mask is populated. Defined here, rather than imported from `factory`, so downstream programs (`mint`, `transfer-control`, …) can `AccountLoader<AssetClassVersion>` it without a circular dependency on `factory`. A compile-time size assertion in `factory/src/state.rs` guards the two struct definitions against diverging.

`FUNCTIONALITIES_BITS_MASK` / `FUNCTIONALITIES_BYTES_MASK` size the `mask` field; `ASSET_CLASS_VERSION_STATE_DRAFT` / `ASSET_CLASS_VERSION_STATE_FINALIZED` are the two values of the `state` field, checked by `require_functionality` above.

---

## Error Codes

```rust
pub enum CommonError {
    MintPaused,                     // mint's Pausable extension has paused = true
    Deactivated,                    // deactivate_pda account exists
    FunctionalityOutOfBounds,       // functionality is past the AssetClassVersion.mask's capacity
    FunctionalityNotSupportedError, // functionality bit not set in AssetClassVersion.mask
    InvalidAssetConfigurationData,  // could not read the asset_configuration account data
    AssetClassVersionNotFinalized,  // asset-class version is still Draft
    RoleOutOfBounds,                // role id is past the Roles.mask's capacity
    MissingRole,                    // signer's Roles PDA lacks the required role bit
    WhitelistPdaMismatch,           // a remaining_accounts whitelist PDA doesn't match the derived address for its destination
    InvalidMerkleProof,             // (account, balance) not proven against the snapshot root
}
```

---

## Function: `require_active`

```rust
pub fn require_active(deactivate_pda: &AccountInfo) -> Result<()>
```

Checks that `deactivate_pda` (seeds `["deactivate", mint]`, owned by `deactivate`) has empty data. An empty account means the mint has not been deactivated. Returns `Err(CommonError::Deactivated)` if the PDA exists.

Callers pass the account as `&AccountInfo` to avoid importing `deactivate` as a crate dependency.

---

## Function: `require_not_paused`

```rust
pub fn require_not_paused(mint_account: &AccountInfo) -> Result<()>
```

Parses the Token-2022 extension data of the mint using `StateWithExtensions::<Mint>::unpack` and locates the `PausableConfig` extension. Returns `Err(CommonError::MintPaused)` if `pausable_config.paused` is `true`, `Ok(())` if the mint is not paused. If the mint has no `PausableConfig` extension at all, `get_extension` returns `Err` (propagated via `?`) rather than `Ok(())` — this should never happen for a correctly deployed mint, since `deploy_mint` always attaches the extension.

---

## Function: `require_functionality`

```rust
pub fn require_functionality(asset_class_version: Ref<AssetClassVersion>, functionality: u16) -> Result<()>
```

Checks whether `functionality` (one of `common::functionalities`'s per-instruction `u16` constants) is enabled in a `factory` `AssetClassVersion` account's mask. Requires the version to be finalized (`AssetClassVersionNotFinalized` otherwise), then reads the bit via `bitmask::is_set` on `asset_class_version.mask`.

The caller passes a `Ref<AssetClassVersion>` obtained from its own `AccountLoader<AssetClassVersion>` via `.load()?` — a **zero-copy** typed view. `common::state::AssetClassVersion` is a field-for-field mirror of `factory::state::AssetClassVersion` (kept in sync by a compile-time size assertion in `factory/src/state.rs`), defined here so downstream programs can load the account without importing `factory` (which would be circular).

Maps `bitmask::is_set`'s out-of-range signal to `Err(CommonError::FunctionalityOutOfBounds)`, returns `Err(CommonError::FunctionalityNotSupportedError)` if the bit isn't set, `Ok(())` otherwise.

---

## Function: `require_role`

```rust
pub fn require_role(roles_pda: Ref<Roles>, role: u16) -> Result<()>
```

Checks whether `role` (one of `common::roles`'s `u16` constants, e.g. `ROLE_ADMIN`) is granted in an `access-control` `Roles` account's mask. Reads the bit via `bitmask::is_set` on `roles_pda.mask`; maps the out-of-range signal to `Err(CommonError::RoleOutOfBounds)`, returns `Err(CommonError::MissingRole)` if the bit isn't set, `Ok(())` otherwise.

The caller passes a `Ref<Roles>` obtained from its own `AccountLoader<Roles>` via `.load()?` — a **zero-copy** typed view, exactly like `require_functionality`. `common::state::Roles` is a field-for-field mirror of `access-control::state::Roles` (kept in sync by compile-time size *and* discriminator assertions in `access-control/src/state.rs`), defined here so callers can load the account without importing `access-control` (which would be circular).

**Behavioural note**: because the account is now a typed `AccountLoader<Roles>`, Anchor validates its owner / discriminator at account resolution *before* the handler runs. A signer with **no** `Roles` PDA (a never-created, system-owned account) therefore fails with Anchor's `AccountOwnedByWrongProgram` (or `AccountNotInitialized`) rather than `MissingRole`. `MissingRole` is now reserved for the case where the PDA exists but the required bit is unset. An admin acting on their own PDA (`authority == account`) is still safe: `require_role` takes the `Ref` by value and drops it before the caller's mutable `load_init`/`load_mut` of the same account, so the borrows never overlap.

---

## Function: `verify_whitelist_pda`

```rust
pub fn verify_whitelist_pda(
    whitelist_pda: &AccountInfo,
    destination: &Pubkey,
    mint: &Pubkey,
) -> Result<()>
```

Re-derives the canonical `["whitelist", mint, destination]` PDA (owned by `transfer-control`) and checks it matches `whitelist_pda.key()`, returning `Err(CommonError::WhitelistPdaMismatch)` on a mismatch. Needed only where a whitelist PDA arrives without an Anchor `seeds` constraint — e.g. `mint::batch_mint`, which reads a whitelist PDA per destination from `remaining_accounts` (Anchor can't constrain seeds against a dynamic account list). Whether the PDA must *exist* (whitelist mode active) is a separate check left to the caller — see `transfer_control::verify_whitelist`.

---

## Module: `pda_utils`

`is_caller_pda(caller, program_seeds, program_id) -> bool` and `build_pda_signer_seeds(seeds, bump) -> Vec<&[u8]>` are small shared helpers used throughout the workspace for CPI-authorization checks and building `invoke_signed` seed slices.

### Function: `create_or_adopt_pda`

```rust
pub fn create_or_adopt_pda<'info>(
    payer: &AccountInfo<'info>,
    pda: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    program_id: &Pubkey,
    space: usize,
    signer_seeds: &[&[u8]],
) -> Result<()>
```

Creates `pda` (owned by `program_id`, sized `space`) the same way Anchor's own `#[account(init, ...)]` constraint does under the hood, tolerating a PDA that already holds lamports. A plain `system_instruction::create_account` CPI unconditionally fails with `AccountAlreadyInUse` if the destination already has `lamports() > 0` — including a zero-data account that was merely sent lamports. Since a PDA's address is derivable by anyone, an attacker can grief any `create_account`-based initialization by pre-funding the target address with a single lamport before the legitimate transaction lands, permanently blocking that exact call.

When `pda` has no lamports yet, this does a plain `create_account` (funds + allocates + assigns atomically). Otherwise it falls back to the same two-step sequence Anchor's `init` uses: top up to rent-exemption via `transfer` (only if needed), then `allocate` + `assign` separately — since `create_account` itself refuses to run against a non-empty-lamports account. Needed anywhere a PDA is created manually via `remaining_accounts` rather than through a typed Anchor account (Anchor's `init` can't target a variable-length account list) — e.g. `freeze::batch_freeze`, which creates one `frozen_account_pda` per entry.

---

## Module: `merkle`

Merkle-proof verification for snapshot balances. The snapshot programs store only a 32-byte Merkle root per snapshot; a holder's `(account, balance)` is proven against that root off-chain-style, on demand (e.g. in `treasury::pay_coupon`).

```rust
pub struct LeafData { pub account: Pubkey, pub amount: u64 }   // + fn hash(&self) -> [u8; 32]

pub fn leaf_hash(account: &Pubkey, balance: u64) -> [u8; 32];

pub fn verify_balance_proof(
    proof: &[[u8; 32]],
    root: [u8; 32],
    account: Pubkey,
    balance: u64,
) -> bool;
```

- **Leaf** — `leaf_hash = keccak(account || balance.to_le_bytes())`. The balance uses **all 8 bytes little-endian** (e.g. `1500` → `dc 05 00 00 00 00 00 00`). Exactly one leaf per account. `verify_balance_proof` always recomputes this from the `(account, balance)` inputs — it never accepts a raw leaf hash.
- **Tree** — **sorted-pair** (commutative): every internal node is `keccak(sort(left, right))`, comparing the two 32-byte children lexicographically. Proofs therefore carry only the sibling hashes (no left/right direction bits), and only leaf *existence* is proven, not position.
- **`verify_balance_proof`** — folds `proof` up from the leaf using the sorted-pair rule and returns `true` iff the result equals `root`. An empty `proof` means a single-leaf tree (`leaf_hash == root`). This is a **pure `bool` primitive**, deliberately Anchor-error-free so it stays host-testable (`assert!(verify_balance_proof(...))`).
- **`require_balance_proof`** (defined in `lib.rs`, not `merkle`) — the `require_*`-style wrapper callers should use: `require_balance_proof(proof, root, account, balance)?` calls the primitive and raises `CommonError::InvalidMerkleProof` on failure. Same split as `verify_whitelist_pda` — a pure check plus a `Result`-returning wrapper — so the crypto module never depends on Anchor's error machinery.

```rust
pub fn require_balance_proof(
    proof: &[[u8; 32]],
    root: [u8; 32],
    account: Pubkey,
    balance: u64,
) -> Result<()>;
```

### Hashing

`solana-keccak-hasher` = **keccak256** (the Ethereum / bubblegum-cNFT variant), **not** NIST SHA3-256 — they differ in padding. The off-chain tree builder **must** use keccak256 (e.g. `@noble/hashes/sha3`'s `keccak_256`, *not* `sha3_256`). On the `solana` target `hashv` calls the `sol_keccak256` syscall; the crate's `sha3` feature provides a host implementation so the unit tests run under `cargo test`.

### Security notes

- **No explicit leaf/node domain separation.** Forgery of an internal node as a leaf (the classic second-preimage attack) is prevented *by length*: the leaf preimage is 40 bytes (32 + 8) while an internal-node preimage is 64 bytes, and the verifier always recomputes the leaf from structured inputs — so the two hash domains can never overlap. **This safety depends on the leaf staying < 64 bytes**; changing the leaf format to ≥ 64 bytes (or a variable size) would silently reintroduce the attack. If the leaf ever grows, add explicit prefix bytes (`0x00` leaf / `0x01` node) and match them off-chain.
- **The verifier can only be as sound as the tree that produced `root`.** The off-chain builder must guarantee: exactly one leaf per account, canonical sorted-pair construction with safe odd-level handling (promote the lone node, do **not** naively duplicate it), and the same lexicographic (bytewise) sibling ordering + `u64` LE encoding used here.
- **Bound the proof length in the caller.** This pure function does not cap `proof.len()`; each level is a keccak syscall. On-chain callers (e.g. `treasury::pay_coupon`) should `require!` a sane maximum (a legitimate proof is `ceil(log2(N))` — well under 32) to keep compute-unit usage deterministic.

---

## Module: `functionalities`

```rust
// flat u16 identifiers, one per instruction across the whole workspace
// (append-only, sequential from 0), excluding `factory` itself
pub const BOND_UPDATE_BOND_TERMS: u16 = 0;
pub const COUPON_CREATE_COUPON: u16 = 1;
// … one constant per instruction, named `<PROGRAM>_<INSTRUCTION>` …
pub const ACCESS_CONTROL_REVOKE_ROLES: u16 = 21;
```

A single, continuous `u16` counter across the whole file — values are **not** scoped per program, so an existing constant must never be reordered or removed; new functionalities are only ever appended at the end. A unit test (`functionality_constants_are_sequential_from_zero`) parses the file's own source via `include_str!` and asserts every constant's value matches its 0-based declaration position, so the invariant can't silently drift.

These ids are the bit positions read/written in a `factory` `AssetClassVersion`'s `mask` (see `require_functionality` above, and [`docs/factory.md`](factory.md) for how the mask itself is populated per asset-class version).

---

## Module: `roles`

```rust
// flat u16 role ids (append-only, sequential from 0)
pub const ROLE_ADMIN: u16 = 0;
pub const ROLE_CONTROLLER: u16 = 1;
pub const ROLE_CONTROL_LIST: u16 = 2;
pub const ROLE_CORPORATE_ACTION: u16 = 3;
pub const ROLE_ISSUER: u16 = 4;
pub const ROLE_TREASURER: u16 = 5;
pub const ROLE_PAUSER: u16 = 6;              // guards pause / unpause
pub const ROLE_FREEZE_MANAGER: u16 = 7;      // guards freeze / unfreeze / partial-freeze
pub const ROLE_DEACTIVATE: u16 = 8;
pub const ROLE_CUSTOM_DATA_MANAGER: u16 = 9; // guards metadata update / remove
pub const ROLES_MASK_OFFSET: usize = 8 + 8;  // discriminator + Roles header; where the mask starts
```

Mirrors `common::functionalities` but for `access-control` roles: a flat, append-only `u16`
counter (a unit test asserts the constants are sequential from 0). `ROLES_MASK_OFFSET` records
where the mask begins in a serialized `Roles` account; it is no longer used by `require_role`
(which now takes a typed `Ref<Roles>` and reads the `.mask` field directly).

---

## Module: `bitmask`

Generic bit-mask primitives, reused by every program that stores a `[u8; N]` bit-mask
(`factory`'s `AssetClassVersion.mask`, `access-control`'s `Roles.mask`, and
`require_functionality` above). Centralizes the arithmetic so no program repeats it.

```rust
pub const MASK_CHUNK_BITS: usize = 8;                                    // bits per byte; shared by all masks
pub fn set_bits(mask: &mut [u8], positions: &[u16]) -> Result<(), u16>   // turn bits on
pub fn clear_bits(mask: &mut [u8], positions: &[u16]) -> Result<(), u16> // turn bits off
pub fn is_set(mask: &[u8], position: u16) -> Result<bool, u16>           // read one bit
```

The mask is passed as a raw slice, so the bound is derived from `mask.len() * MASK_CHUNK_BITS`
— no per-domain capacity constant is needed here, and the domains share the mechanism without
coupling their sizes. Each `set_bits` / `clear_bits` is a targeted merge (`|= 1 << bit` /
`&= !(1 << bit)`): bits outside `positions` are left untouched.

**These helpers are error-type agnostic.** They do not raise an Anchor error themselves — on an
out-of-range position they return `Err(position)` (the offending `u16`) and stop, leaving each
caller to raise its own domain error: `factory` maps to `ErrorCode::FunctionalityOutOfBounds`,
`access-control` (in `set_bits`/`clear_bits`) to `AccessControlError::RoleOutOfBounds`,
`require_functionality` to `CommonError::FunctionalityOutOfBounds`, and `require_role` to
`CommonError::RoleOutOfBounds` — all via `.map_err(|_| error!(…))?`.

Per-domain capacities (`FUNCTIONALITIES_BITS_MASK`, `ROLES_BITS_MASK`, …) stay with their
own structs; only `MASK_CHUNK_BITS` is shared.

---

## Usage in downstream programs

Add to `Cargo.toml`:
```toml
[dependencies]
common = { path = "../common" }
```

Then call the helpers directly:
```rust
use common::{require_active, require_not_paused, require_functionality, require_role};
```
