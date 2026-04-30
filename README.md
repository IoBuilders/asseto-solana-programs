# CMTAT One Atelier — Project Context

## Purpose

Modular multi-program Anchor workspace extending Token-2022 for CMTAT-compliant token issuance. Each extension is governed by a dedicated program owning a PDA authority for it.

---

## Code Structure

```
./
├── Anchor.toml               — program IDs (localnet) + test runner config
├── Cargo.toml                — workspace root (glob: programs/*)
├── programs/
│   ├── cmtat-common/         — shared library: no program ID, no entrypoint
│   ├── cmtat-deploy/         — deploys mints; records deployer
│   ├── cmtat-mint/           — controls token minting
│   ├── cmtat-metadata-update/— controls metadata updates
│   ├── cmtat-freeze/         — controls freeze/thaw (block/unblock + management freeze)
│   ├── cmtat-operations/     — burn via permanent delegate
│   ├── cmtat-pause/          — pause/unpause the mint
│   ├── cmtat-deactivate/     — permanently deactivate the mint
│   ├── cmtat-transfer-control/ — whitelist / clearing mode
│   ├── cmtat-transfer/       — custom transfer with all compliance checks
│   └── cmtat-transfer-hook/  — SPL Transfer Hook interface handler
└── tests/                    — one .ts file per program
```

Each program:
```
programs/cmtat-<name>/src/
├── lib.rs           — declare_id!, mod declarations, #[program] impl
├── constants.rs     — program IDs used in account constraints
├── errors.rs        — #[error_code] enum (if needed)
├── state.rs / state/ — on-chain account structs (if needed)
└── instructions/
    ├── mod.rs
    └── <instruction>.rs
```

**`cmtat-common`**: shared library crate (no program ID, no entrypoint). All cross-program shared logic lives here:
- `state::MintOwner` — struct for the `mint_owner_pda` created by `cmtat-deploy`; defined here so downstream programs avoid importing `cmtat-deploy`. Uses `#[derive(AnchorSerialize, AnchorDeserialize)]` (not `#[account]`, which requires `declare_id!`). `cmtat-deploy` defines its own `#[account] MintOwner` wrapping the same fields for `Account<MintOwner>` usage.
- `verify_deployer()` — Borsh-deserializes `MintOwner` (skipping discriminator) and checks the signer.
- `verify_deactivate()` — checks that the `deactivate_pda` account is empty (mint not deactivated).
- `verify_unpause()` — parses the `PausableConfig` extension of the mint and errors if paused.

---

## Program IDs

| Program | ID |
|---|---|
| `cmtat-deploy` | `2XMEMg7FUxWksDRZQU9vtGHHSyKoSaH9bncj1noe38QK` |
| `cmtat-mint` | `AXGtgWoPXfyfQ7o823WG2ip6qSRw1s3wA3RCSdtCyN1P` |
| `cmtat-metadata-update` | `Ei1dX3P7N9cBz2Vs28iB8nsWFqUAWTDicGX7YZSc5HXU` |
| `cmtat-freeze` | `ERyVR64dpCpoEa335A7LfJZnrEUeL7bxgqfqTogXYoAr` |
| `cmtat-operations` | `BANmGRnoLxXCTzKm2aM1Zww8qn7GN2KBkbyY7QpW3vcX` |
| `cmtat-pause` | `9GjHsbG5MgerXdyWRmNVMP9uXzi9iZyRyCrKw1LnSw1w` |
| `cmtat-deactivate` | `8rds1q4evGug816bswEEmDmJSymq86sq7mgYRcPQP996` |
| `cmtat-transfer-control` | `BTLbhoZDCguRqmwhXvQej7pmAqV2TXY3iGdwMPsMBBMw` |
| `cmtat-transfer` | `EY3ndaFy8e647firyg1MiyNH9LJkBKfV9VK8CNc4N1MD` |
| `cmtat-transfer-hook` | `482AUGU4SbYePPHaV7yvXrGEprHhiWSTRBds4Bdr6CPz` |

### ID sharing pattern

Reference another program's ID via crate import — `declare_id!` is the single source of truth:
```rust
pub use cmtat_mint::ID as MINT_AUTHORITY_PROGRAM_ID;  // in cmtat-deploy/constants.rs
```
Add the target as a dependency with `features = ["cpi"]`. When a circular dependency prevents a crate import, hardcode the ID as `Pubkey::new_from_array` with a comment and keep it manually in sync.

**Circular dependency map** — programs that must hardcode IDs because the natural import direction would create a cycle:

| Program needing the ID | ID they hardcode | Why |
|---|---|---|
| `cmtat-freeze` | `cmtat-deploy`, `cmtat-deactivate`, `cmtat-mint`, `cmtat-operations`, `cmtat-transfer` | `cmtat-mint`, `cmtat-operations`, and `cmtat-transfer` all depend on `cmtat-freeze` for CPI |
| `cmtat-mint` | `cmtat-deploy`, `cmtat-deactivate` | `cmtat-deploy` depends on `cmtat-mint` |
| `cmtat-transfer` | `cmtat-deploy`, `cmtat-deactivate` | `cmtat-deploy` depends on `cmtat-transfer` indirectly |

---

## Instruction Categories

Every program exposes instructions in one of three categories:

| Category | Caller | Auth check |
|---|---|---|
| **Management** | Deployer | `verify_deployer()` + optional `verify_unpause()` / `verify_deactivate()` |
| **Operational** | Token holders / participants | Program-specific access controls |
| **Auxiliary** | Other programs via CPI only | Requires a specific known PDA as `Signer` (only the authorized program can produce it via `invoke_signed`) |

Auxiliary instructions cannot be called by any external wallet. `block_account` / `unblock_account` in `cmtat-freeze` accept three callers: `mint_authority` (cmtat-mint), `permanent_delegate` (cmtat-operations), and `transfer` (cmtat-transfer).

---

## PDA Seed Reference

| Seeds | Owner | Purpose |
|---|---|---|
| `["mint_owner", mint]` | `cmtat-deploy` | Stores deployer + bump; type `cmtat-common::state::MintOwner` |
| `["temp_mint_authority", mint]` | `cmtat-deploy` | Ephemeral signing key during `deploy_mint` only |
| `["mint_authority", mint]` | `cmtat-mint` | Token-2022 mint authority |
| `["metadata_update_authority", mint]` | `cmtat-metadata-update` | Token-2022 metadata update authority |
| `["freeze_authority", mint]` | `cmtat-freeze` | Token-2022 freeze authority |
| `["frozen_account", mint, account]` | `cmtat-freeze` | Marker: account fully frozen at CMTAT level |
| `["frozen_balance", mint, account]` | `cmtat-freeze` | Stores locked balance for partial freeze |
| `["permanent_delegate", mint]` | `cmtat-operations` | Token-2022 PermanentDelegate authority |
| `["pausable_authority", mint]` | `cmtat-pause` | Token-2022 Pausable authority |
| `["deactivate", mint]` | `cmtat-deactivate` | Marker: mint permanently deactivated |
| `["transfer_control_mode", mint]` | `cmtat-transfer-control` | Stores `is_clearing` flag |
| `["whitelist", mint, account]` | `cmtat-transfer-control` | Marker: account is whitelisted |
| `["transfer", mint]` | `cmtat-transfer` | Transfer authority; signs freeze/thaw CPIs |
| `["transfer_hook_authority", mint]` | `cmtat-transfer-hook` | Token-2022 TransferHook extension authority |
| `["extra-account-metas", mint]` | `cmtat-transfer-hook` | SPL ExtraAccountMetaList for the hook |

Always use `seeds::program` when referencing a PDA owned by another program:
```rust
#[account(seeds = [b"mint_owner", mint.key().as_ref()], seeds::program = constants::CMTAT_DEPLOY_PROGRAM_ID, bump)]
pub mint_owner_pda: UncheckedAccount<'info>,
```

---

## Token-2022 Extensions

| Extension | Authority PDA seeds | Owner program | Behaviour |
|---|---|---|---|
| `PermanentDelegate` | `["permanent_delegate", mint]` | `cmtat-operations` | Burn/transfer from any account |
| `MetadataPointer` | None (immutable) | — | Points to mint itself |
| `Pausable` | `["pausable_authority", mint]` | `cmtat-pause` | Pause/unpause all Token-2022 operations |
| `DefaultAccountState(Frozen)` | `["freeze_authority", mint]` | `cmtat-freeze` | All new accounts start frozen; thawed/re-frozen transiently during mint/burn/transfer |
| `TokenMetadata` | `["metadata_update_authority", mint]` | `cmtat-metadata-update` | Embedded name/symbol/URI + custom fields |
| `TransferHook` | `["transfer_hook_authority", mint]` | `cmtat-transfer-hook` | Invokes `cmtat-transfer-hook::execute` on every `transfer_checked` |

---

## Checklist: Adding a New Program

1. Create `programs/cmtat-<name>/` with the standard structure.
2. `constants.rs`: `pub use cmtat_deploy::ID as CMTAT_DEPLOY_PROGRAM_ID;` (or hardcode if circular dep).
3. Add to `Anchor.toml` `[workspace]` members and `[programs.localnet]`.
4. Implement instructions following the correct category pattern above.
5. If the program owns a Token-2022 extension authority PDA: wire it into `cmtat-deploy` (add crate dep with `cpi` feature, export ID in `constants.rs`, add authority PDA to `DeployMint` accounts, call the extension initializer CPI).
6. Add `tests/cmtat-<name>.ts` with a `deployMint()` helper.
7. Create `docs/cmtat-<name>.md` and link it below.

## Keeping Docs in Sync

| Change | Update |
|---|---|
| New program | `docs/cmtat-<name>.md` + link below + `CLAUDE.md` tables |
| New / modified instruction | relevant `docs/` file |
| Program ID changed | Program IDs table + relevant `docs/` file + any hardcoded constants |
| New PDA | PDA Seed Reference table |

---

## Detailed Program References

- [`docs/cmtat-common.md`](docs/cmtat-common.md)
- [`docs/cmtat-deploy.md`](docs/cmtat-deploy.md)
- [`docs/cmtat-mint.md`](docs/cmtat-mint.md)
- [`docs/cmtat-metadata-update.md`](docs/cmtat-metadata-update.md)
- [`docs/cmtat-freeze.md`](docs/cmtat-freeze.md)
- [`docs/cmtat-operations.md`](docs/cmtat-operations.md)
- [`docs/cmtat-pause.md`](docs/cmtat-pause.md)
- [`docs/cmtat-deactivate.md`](docs/cmtat-deactivate.md)
- [`docs/cmtat-transfer-control.md`](docs/cmtat-transfer-control.md)
- [`docs/cmtat-transfer.md`](docs/cmtat-transfer.md)
- [`docs/cmtat-transfer-hook.md`](docs/cmtat-transfer-hook.md)
