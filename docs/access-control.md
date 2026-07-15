# access-control — Program Reference

Program ID: `GpyjQqBWux3JYqxKCXFrDbWZmhFWBJWVaVivkBW2DL2w`

Role-based access control per mint. Each `(mint, account)` pair has a bit-mask PDA
in which bit `i = 1` means role `i` is granted to that account on that mint.
`grant_roles` turns bits on, `revoke_roles` turns them off.

Both instructions are **admin-gated and functionality-gated**: they must be signed by an
account that already holds `ROLE_ADMIN` on the mint, the relevant functionality
(`ACCESS_CONTROL_GRANT_ROLES` / `ACCESS_CONTROL_REVOKE_ROLES`) must be enabled in the mint's
asset-class version, and the mint must be neither paused nor deactivated.

Role identifiers are the `u16` constants in [`common::roles`](common.md) (currently only
`ROLE_ADMIN = 0`); they index bit positions in the `Roles.mask`.

---

## State: `Roles`

```rust
#[account(zero_copy)]
#[repr(C)]
pub struct Roles {
    pub bump: u8,
    pub _padding: [u8; 7],
    pub mask: [u8; ROLES_BYTES_MASK], // 1024 bytes = 8_192 role bits
}
// LEN = 8 (discriminator) + 8 (header) + 1024 (mask) = 1040 bytes
// Seeds: [mint, account]
```

**Zero-copy** (`AccountLoader`): the mask is large, so the account bytes are reinterpreted in
place rather than deserialised as a whole. `#[repr(C)]` with an explicit `_padding` keeps the
header at 8 bytes so there is no implicit padding before `mask` (`ROLES_BYTES_MASK` is a
multiple of 8).

Constants (`state.rs`): `ROLES_BITS_MASK = 8_192`, `ROLES_BYTES_MASK = ROLES_BITS_MASK / MASK_CHUNK_BITS = 1_024`. The chunk size (`MASK_CHUNK_BITS = 8`) is shared across the workspace and lives in `common::bitmask`. A compile-time assertion in `state.rs` pins `Roles.mask`'s byte offset to `common::roles::ROLES_MASK_OFFSET`, which `common::require_role` relies on to read the mask straight from account bytes.

Bit manipulation is delegated to the shared [`common::bitmask`](common.md) helpers
(`set_bits` / `clear_bits`), which bounds-check each `u16` against the mask length. Those
helpers are error-agnostic — they return the offending position — so this program maps that
signal to its own `RoleOutOfBounds` via `.map_err(|_| error!(AccessControlError::RoleOutOfBounds))`.

---

## Authorization: the admin gate

Both instructions call [`common::require_role`](common.md)`(authority_roles_pda, ROLE_ADMIN)`.
The `authority_roles_pda` is the signer's **own** `Roles` PDA (seeds `[mint, authority]`), so
holding `ROLE_ADMIN` there authorises the call. A missing PDA, or one without bit 0 set, fails
with `CommonError::MissingRole`.

An admin may target **themselves** (`authority == account`). That makes the authority PDA and
the target `roles_pda` the same account; `require_role` reads it through a short-lived borrow
that is released before the target is loaded mutably, so there is no borrow conflict.

There is no on-chain bootstrap for the first admin yet, nor a last-admin-lockout guard —
these are intentionally out of scope for now.

---

## Error codes (`AccessControlError`)

| Code | Message |
|---|---|
| `RoleOutOfBounds` | Role id is past the mask capacity |

Other failures surface as `common::CommonError` variants: `MissingRole` (authority lacks
`ROLE_ADMIN`), `FunctionalityNotSupportedError` / `AssetClassVersionNotFinalized` (functionality
gate), `MintPaused`, `Deactivated`.

---

## Instruction: `grant_roles` (Operational — admin only)

Parameters: `roles: Vec<u16>` — the role ids to grant.

Creates the `roles_pda` on the first call (`init_if_needed`) or updates it if it already
exists, then for each id sets its bit via `mask[byte] |= 1 << bit` (a targeted merge —
bits outside `roles` are left untouched).

### Preconditions

- `require_role(authority_roles_pda, ROLE_ADMIN)` — signer must hold the admin role.
- `require_not_paused` — the mint must not be paused.
- `require_active` — the mint must not be deactivated.
- `require_functionality(ACCESS_CONTROL_GRANT_ROLES)` — enabled in the mint's asset-class version.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Funds the PDA on the first call |
| `authority` | no | yes | Signer | The caller; must hold `ROLE_ADMIN` |
| `mint_owner_pda` | no | no | `Account<MintOwner>` | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `authority_roles_pda` | no | no | UncheckedAccount | seeds `[mint, authority]`; read by `require_role` |
| `account` | no | no | UncheckedAccount | The grantee; any account; used only as a `roles_pda` seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; checked by `require_active` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `roles_pda` | yes | no | `AccountLoader<Roles>` | init_if_needed; seeds `[mint, account]` |
| `system_program` | no | no | Program<System> | |
| `asset_class_version_pda` | no | no | `AccountLoader<AssetClassVersion>` | seeds `["asset_class_version", config_id, version_id]`, `seeds::program = FACTORY_PROGRAM_ID`, ids from `mint_owner_pda`; checked by `require_functionality` |

### Execution

1. `require_role(&authority_roles_pda, ROLE_ADMIN)`
2. `require_not_paused(&mint)`
3. `require_active(&deactivate_pda)`
4. `require_functionality(asset_class_version_pda.load()?, ACCESS_CONTROL_GRANT_ROLES)`
5. Load the PDA: `load_init` (fresh account → also writes `bump`) or, if it already exists, `load_mut`
6. `common::bitmask::set_bits(&mut roles_pda.mask, &roles)` — turns on each role bit

---

## Instruction: `revoke_roles` (Operational — admin only)

Parameters: `roles: Vec<u16>` — the role ids to revoke.

The inverse of `grant_roles`: the `roles_pda` must already exist, and each id's bit is cleared
via `mask[byte] &= !(1 << bit)` (a targeted merge — bits outside `roles` are left untouched).

### Preconditions

- `require_role(authority_roles_pda, ROLE_ADMIN)` — signer must hold the admin role.
- `require_not_paused` — the mint must not be paused.
- `require_active` — the mint must not be deactivated.
- `require_functionality(ACCESS_CONTROL_REVOKE_ROLES)` — enabled in the mint's asset-class version.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | no | yes | Signer | The caller; must hold `ROLE_ADMIN` |
| `mint_owner_pda` | no | no | `Account<MintOwner>` | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `authority_roles_pda` | no | no | UncheckedAccount | seeds `[mint, authority]`; read by `require_role` |
| `account` | no | no | UncheckedAccount | The target; any account; used only as a `roles_pda` seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; checked by `require_active` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `roles_pda` | yes | no | `AccountLoader<Roles>` | mut; seeds `[mint, account]`; must already exist |
| `asset_class_version_pda` | no | no | `AccountLoader<AssetClassVersion>` | seeds `["asset_class_version", config_id, version_id]`, `seeds::program = FACTORY_PROGRAM_ID`, ids from `mint_owner_pda`; checked by `require_functionality` |

### Execution

1. `require_role(&authority_roles_pda, ROLE_ADMIN)`
2. `require_not_paused(&mint)`
3. `require_active(&deactivate_pda)`
4. `require_functionality(asset_class_version_pda.load()?, ACCESS_CONTROL_REVOKE_ROLES)`
5. `load_mut` the PDA (fails at account resolution if it does not exist)
6. `common::bitmask::clear_bits(&mut roles_pda.mask, &roles)` — turns off each role bit

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
