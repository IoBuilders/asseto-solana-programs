# common — Shared Library Reference

No program ID. No entrypoint. This is a Rust library crate imported by all other programs in the workspace.

All logic and types that are shared across programs live here. Adding a dependency from any program to `common` does not create a circular dependency because `common` has no dependencies on any program in this workspace.

---

## State: `MintOwner`

```rust
// Uses #[derive(AnchorSerialize, AnchorDeserialize)] — NOT #[account]
// because #[account] requires declare_id!, which a library crate cannot have.
pub struct MintOwner {
    pub deployer: Pubkey,
    pub asset_class_config_id: u64,   // asset-class PDA seed (1/2)
    pub asset_class_version_id: u64,  // asset-class PDA seed (2/2)
    pub bump: u8,
}
// LEN = 8 (discriminator) + 32 (deployer) + 8 (asset_class_config_id) + 8 (asset_class_version_id) + 1 (bump) = 57 bytes
```

Defined here so downstream programs can deserialize `mint_owner_pda` without importing `deploy`. `deploy` defines its own `#[account] MintOwner` (with the same fields) so it can use `Account<MintOwner>` in its accounts struct.

---

## Error Codes

```rust
pub enum CommonError {
    UnauthorizedDeployer,           // signer does not match stored deployer
    MintPaused,                     // mint's Pausable extension has paused = true
    Deactivated,                    // deactivate_pda account exists
    FunctionalityOutOfBounds,       // functionality is past the AssetClassVersion.mask's capacity
    FunctionalityNotSupportedError, // functionality bit not set in AssetClassVersion.mask
    InvalidMintOwnerData,           // could not read the mint_owner account data
    AssetClassVersionNotFinalized,  // asset-class version is still Draft
    RoleOutOfBounds,                // role id is past the Roles.mask's capacity
    MissingRole,                    // signer's Roles PDA lacks the required role bit
}
```

---

## Function: `verify_deployer`

```rust
pub fn verify_deployer(mint_owner_pda: &AccountInfo, deployer: &Pubkey) -> Result<()>
```

Borsh-deserializes the `MintOwner` stored in `mint_owner_pda` (skipping the 8-byte Anchor discriminator) and checks that `deployer` matches the stored pubkey.

**Why `&AccountInfo` instead of `Account<MintOwner>`**: Anchor's `Account<T>` enforces ownership by the *current* program, but `mint_owner_pda` is owned by `deploy`. Passing it as `&AccountInfo` avoids that check. The `seeds::program` constraint in every caller's account struct already guarantees the account address is correct, making the discriminator check redundant.

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

Parses the Token-2022 extension data of the mint using `StateWithExtensions::<Mint>::unpack` and locates the `PausableConfig` extension. Returns `Err(CommonError::MintPaused)` if `pausable_config.paused` is `true`. Returns `Ok(())` if the extension is absent or the mint is not paused.

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

## Module: `roles`

```rust
pub const ROLE_ADMIN: u16 = 0;                 // flat u16 role ids (append-only, sequential)
pub const ROLES_MASK_OFFSET: usize = 8 + 8;    // discriminator + Roles header; where the mask starts
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
use common::{verify_deployer, require_active, require_not_paused, require_functionality, require_role};
```
