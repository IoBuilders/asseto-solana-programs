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
pub fn require_functionality(asset_class_version: &AccountInfo, functionality: u16) -> Result<()>
```

Checks whether `functionality` (one of `common::functionalities`'s per-instruction `u16` constants) is enabled in a `factory` `AssetClassVersion` account's mask. Reads the mask bit directly out of the raw account data — 8-byte Anchor discriminator, then everything in `common::state::AssetClassVersion` (a field-for-field mirror of `factory::state::AssetClassVersion`, kept in sync by a compile-time size assertion in `factory/src/state.rs`) before `mask` — rather than deserializing the whole 1 KiB+ account.

**Why `&AccountInfo` instead of `factory`'s typed `AssetClassVersion`**: same reason as `require_active`/`require_not_paused` above — `factory` already depends on `common`, so the reverse dependency would be circular.

Returns `Err(CommonError::FunctionalityOutOfBounds)` if `functionality` is past the mask's capacity (delegated to `functionalities::index_of`). Returns `Err(CommonError::FunctionalityNotSupportedError)` if the bit isn't set. Returns `Ok(())` otherwise.

---

## Usage in downstream programs

Add to `Cargo.toml`:
```toml
[dependencies]
common = { path = "../common" }
```

Then call the helpers directly:
```rust
use common::{verify_deployer, require_active, require_not_paused, require_functionality};
```
