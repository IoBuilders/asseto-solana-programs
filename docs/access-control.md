# access-control — Program Reference

Program ID: `GpyjQqBWux3JYqxKCXFrDbWZmhFWBJWVaVivkBW2DL2w`

Role-based access control per mint. Each `(mint, account)` pair has a bit-mask PDA
in which bit `i = 1` means role `i` is granted to that account on that mint.
`grant_roles` turns bits on, `revoke_roles` turns them off.

The first admin is bootstrapped by `initialize` — an **auxiliary, CPI-only** instruction
invoked by `deploy::deploy_mint` that creates the deployer's `Roles` PDA and grants it
`ROLE_ADMIN`. `grant_roles` / `revoke_roles` are then the operational admin-gated instructions
used from that point on.

Both instructions are **admin-gated and functionality-gated**: they must be signed by an
account that already holds `ROLE_ADMIN` on the mint, the relevant functionality
(`ACCESS_CONTROL_GRANT_ROLES` / `ACCESS_CONTROL_REVOKE_ROLES`) must be enabled in the mint's
asset-class version, and the mint must be neither paused nor deactivated.

Role identifiers are the `u16` constants in [`common::roles`](common.md) (`ROLE_ADMIN = 0`,
`ROLE_PAUSER = 6`, `ROLE_FREEZE_MANAGER = 7`, `ROLE_CUSTOM_DATA_MANAGER = 9`, …); they index bit
positions in the `Roles.mask`. Beyond `access-control` itself (which uses `ROLE_ADMIN` to gate
`grant_roles` / `revoke_roles`), management instructions in other programs are guarded by their own
role — e.g. `pause`/`unpause` by `ROLE_PAUSER`, `freeze`'s management instructions by
`ROLE_FREEZE_MANAGER`, and `metadata-update`'s by `ROLE_CUSTOM_DATA_MANAGER`.

---

## State: `Roles`

```rust
#[account(zero_copy, discriminator = RolesCommon::DISCRIMINATOR)]
#[repr(C)]
pub struct Roles {
    pub bump: u8,
    pub _padding: [u8; 7],
    pub mask: [u8; ROLES_BYTES_MASK], // 1024 bytes = 8_192 role bits
}
// LEN = 8 (discriminator) + 8 (header) + 1024 (mask) = 1040 bytes
// Seeds: ["roles", mint, account]
```

**Zero-copy** (`AccountLoader`): the mask is large, so the account bytes are reinterpreted in
place rather than deserialised as a whole. `#[repr(C)]` with an explicit `_padding` keeps the
header at 8 bytes so there is no implicit padding before `mask` (`ROLES_BYTES_MASK` is a
multiple of 8).

This struct is a **mirror** of `common::state::Roles` (`RolesCommon`). It borrows that mirror's
discriminator via `#[account(zero_copy, discriminator = RolesCommon::DISCRIMINATOR)]` so that
`common::require_role` — which loads the account through `AccountLoader<common::state::Roles>` —
sees the same discriminator. Two compile-time assertions in `state.rs` guard against drift:
`size_of::<Roles>() == size_of::<RolesCommon>()` and discriminator equality.

Constants: `ROLES_BITS_MASK = 8_192`, `ROLES_BYTES_MASK = ROLES_BITS_MASK / MASK_CHUNK_BITS = 1_024` now live in `common::state` (alongside the mirror), not in this program's `state.rs`. The chunk size (`MASK_CHUNK_BITS = 8`) is shared across the workspace and lives in `common::bitmask`.

Bit manipulation is delegated to the shared [`common::bitmask`](common.md) helpers
(`set_bits` / `clear_bits`), which bounds-check each `u16` against the mask length. Those
helpers are error-agnostic — they return the offending position — so this program maps that
signal to its own `RoleOutOfBounds` via `.map_err(|_| error!(AccessControlError::RoleOutOfBounds))`.

---

## Authorization: the admin gate

Both instructions call [`common::require_role`](common.md)`(authority_roles_pda.load()?, ROLE_ADMIN)`.
The `authority_roles_pda` is the signer's **own** `Roles` PDA (seeds `[mint, authority]`), typed
as `AccountLoader<common::state::Roles>`, so holding `ROLE_ADMIN` there authorises the call. A PDA
that exists but lacks bit 0 fails with `CommonError::MissingRole`. A signer with **no** `Roles` PDA
at all fails earlier, at account resolution, with Anchor's `AccountOwnedByWrongProgram` (the empty,
system-owned account isn't owned by `access-control`) — not `MissingRole`.

An admin may target **themselves** (`authority == account`). That makes the authority PDA and
the target `roles_pda` the same account; `require_role` takes the loaded `Ref<Roles>` by value and
drops it before the target is loaded mutably (`load_init`/`load_mut`), so the borrows never overlap.

The first admin **is** bootstrapped on-chain, by `initialize` (see below) via a CPI from
`deploy::deploy_mint` — it grants `ROLE_ADMIN` to the deployer at deploy time. There is no
last-admin-lockout guard; that is intentionally out of scope for now.

---

## Error codes (`AccessControlError`)

| Code | Message |
|---|---|
| `RoleOutOfBounds` | Role id is past the mask capacity |
| `Unauthorized` | Only the deployer can authorize this instruction (raised by `initialize` when the caller is not the deploy `temp_mint_authority` PDA) |

Other failures surface as `common::CommonError` variants: `MissingRole` (authority's PDA exists
but lacks `ROLE_ADMIN`), `RoleOutOfBounds` (a requested role id exceeds the mask capacity, raised
inside `require_role`), `FunctionalityNotSupportedError` / `AssetClassVersionNotFinalized`
(functionality gate), `MintPaused`, `Deactivated`. A signer with no `Roles` PDA is rejected at
account resolution with Anchor's `AccountOwnedByWrongProgram` before any of these run.

---

## Instruction: `initialize` (Auxiliary — CPI-only, from `deploy`)

Bootstraps the first admin for a mint. Creates the `(mint, account)` `Roles` PDA and grants
`ROLE_ADMIN` (bit 0). Invoked only via CPI from `deploy::deploy_mint`, with `account` = the
deployer, so a freshly deployed mint ends up with its deployer holding `ROLE_ADMIN`.

Unlike `grant_roles` / `revoke_roles`, this instruction is **not** admin-gated (there is no
admin yet — it is creating one) and is **not** functionality- or pause-gated (it must run
during deploy on a fresh mint). Its only gate is the caller check below.

### Authorization

`require!(is_caller_pda(temp_mint_authority, temp_mint_authority_seeds(mint), DEPLOY_PROGRAM_ID))`
— `temp_mint_authority` must be the `deploy` program's `["temp_mint_authority", mint]` PDA. Because
that account is also declared as a `Signer`, only `deploy` can produce its signature (via
`invoke_signed` during `deploy_mint`), making this instruction unreachable by any external wallet.
`account` and `payer` are likewise `Signer`s, so their signatures must propagate from the
originating `deploy_mint` transaction. Fails with `Unauthorized` otherwise.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Funds `roles_pda` creation |
| `temp_mint_authority` | no | yes | Signer | Must be the deploy `["temp_mint_authority", mint]` PDA; signed via CPI by `deploy` |
| `account` | no | yes | Signer | The grantee (the deployer); also a `roles_pda` seed |
| `mint` | no | no | UncheckedAccount | Read-only; used as a `roles_pda` seed |
| `roles_pda` | yes | no | `AccountLoader<Roles>` | init (fails if it already exists); seeds `["roles", mint, account]` |
| `system_program` | no | no | Program<System> | |

### Execution

1. `require!(is_caller_pda(temp_mint_authority, …, DEPLOY_PROGRAM_ID), Unauthorized)`
2. `load_init` the `roles_pda` (always freshly created) and write `bump`
3. `common::bitmask::set_bits(&mut roles_pda.mask, &[ROLE_ADMIN])` — turns on the admin bit

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
| `authority_roles_pda` | no | no | `AccountLoader<Roles>` | the signer's own PDA, seeds `[mint, authority]`; loaded and read by `require_role` (must exist & be owned by `access-control`) |
| `account` | no | no | UncheckedAccount | The grantee; any account; used only as a `roles_pda` seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; checked by `require_active` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `roles_pda` | yes | no | `AccountLoader<Roles>` | init_if_needed; seeds `["roles", mint, account]` |
| `system_program` | no | no | Program<System> | |
| `asset_class_version_pda` | no | no | `AccountLoader<AssetClassVersion>` | seeds `["asset_class_version", config_id, version_id]`, `seeds::program = FACTORY_PROGRAM_ID`, ids from `mint_owner_pda`; checked by `require_functionality` |

### Execution

1. `require_role(authority_roles_pda.load()?, ROLE_ADMIN)`
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
| `authority_roles_pda` | no | no | `AccountLoader<Roles>` | the signer's own PDA, seeds `[mint, authority]`; loaded and read by `require_role` (must exist & be owned by `access-control`) |
| `account` | no | no | UncheckedAccount | The target; any account; used only as a `roles_pda` seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; checked by `require_active` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `roles_pda` | yes | no | `AccountLoader<Roles>` | mut; seeds `["roles", mint, account]`; must already exist |
| `asset_class_version_pda` | no | no | `AccountLoader<AssetClassVersion>` | seeds `["asset_class_version", config_id, version_id]`, `seeds::program = FACTORY_PROGRAM_ID`, ids from `mint_owner_pda`; checked by `require_functionality` |

### Execution

1. `require_role(authority_roles_pda.load()?, ROLE_ADMIN)`
2. `require_not_paused(&mint)`
3. `require_active(&deactivate_pda)`
4. `require_functionality(asset_class_version_pda.load()?, ACCESS_CONTROL_REVOKE_ROLES)`
5. `load_mut` the PDA (fails at account resolution if it does not exist)
6. `common::bitmask::clear_bits(&mut roles_pda.mask, &roles)` — turns off each role bit

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
