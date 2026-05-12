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
│   ├── common/         — shared library: no program ID, no entrypoint
│   ├── deploy/         — deploys mints; records deployer
│   ├── mint/           — controls token minting
│   ├── metadata-update/— controls metadata updates
│   ├── freeze/         — controls freeze/thaw (block/unblock + management freeze)
│   ├── operations/     — burn via permanent delegate
│   ├── pause/          — pause/unpause the mint
│   ├── deactivate/     — permanently deactivate the mint
│   ├── transfer-control/ — whitelist / clearing mode
│   ├── transfer/       — custom transfer with all compliance checks
│   └── transfer-hook/  — SPL Transfer Hook interface handler
└── tests/                    — one .ts file per program
```

Each program:
```
programs/<name>/src/
├── lib.rs           — declare_id!, mod declarations, #[program] impl
├── constants.rs     — program IDs used in account constraints
├── errors.rs        — #[error_code] enum (if needed)
├── state.rs / state/ — on-chain account structs (if needed)
└── instructions/
    ├── mod.rs
    └── <instruction>.rs
```

**`common`**: shared library crate (no program ID, no entrypoint). All cross-program shared logic lives here:
- `state::MintOwner` — struct for the `mint_owner_pda` created by `deploy`; defined here so downstream programs avoid importing `deploy`. Uses `#[derive(AnchorSerialize, AnchorDeserialize)]` (not `#[account]`, which requires `declare_id!`). `deploy` defines its own `#[account] MintOwner` wrapping the same fields for `Account<MintOwner>` usage.
- `verify_deployer()` — Borsh-deserializes `MintOwner` (skipping discriminator) and checks the signer.
- `require_active()` — checks that the `deactivate_pda` account is empty (mint not deactivated).
- `require_not_paused()` — parses the `PausableConfig` extension of the mint and errors if paused.

---

## Program IDs

| Program | ID |
|---|---|
| `deploy` | `2XMEMg7FUxWksDRZQU9vtGHHSyKoSaH9bncj1noe38QK` |
| `mint` | `AXGtgWoPXfyfQ7o823WG2ip6qSRw1s3wA3RCSdtCyN1P` |
| `metadata-update` | `Ei1dX3P7N9cBz2Vs28iB8nsWFqUAWTDicGX7YZSc5HXU` |
| `freeze` | `ERyVR64dpCpoEa335A7LfJZnrEUeL7bxgqfqTogXYoAr` |
| `operations` | `BANmGRnoLxXCTzKm2aM1Zww8qn7GN2KBkbyY7QpW3vcX` |
| `pause` | `9GjHsbG5MgerXdyWRmNVMP9uXzi9iZyRyCrKw1LnSw1w` |
| `deactivate` | `8rds1q4evGug816bswEEmDmJSymq86sq7mgYRcPQP996` |
| `transfer-control` | `BTLbhoZDCguRqmwhXvQej7pmAqV2TXY3iGdwMPsMBBMw` |
| `transfer` | `EY3ndaFy8e647firyg1MiyNH9LJkBKfV9VK8CNc4N1MD` |
| `transfer-hook` | `482AUGU4SbYePPHaV7yvXrGEprHhiWSTRBds4Bdr6CPz` |

### ID sharing pattern

Reference another program's ID via crate import — `declare_id!` is the single source of truth:
```rust
pub use mint::ID as MINT_AUTHORITY_PROGRAM_ID;  // in deploy/constants.rs
```
Add the target as a dependency with `features = ["cpi"]`. When a circular dependency prevents a crate import, hardcode the ID as `Pubkey::new_from_array` with a comment and keep it manually in sync.

**Circular dependency map** — programs that must hardcode IDs because the natural import direction would create a cycle:

| Program needing the ID | ID they hardcode | Why |
|---|---|---|
| `freeze` | `deploy`, `deactivate`, `mint`, `operations`, `transfer` | `mint`, `operations`, and `transfer` all depend on `freeze` for CPI |
| `mint` | `deploy`, `deactivate` | `deploy` depends on `mint` |
| `transfer` | `deploy`, `deactivate` | `deploy` depends on `transfer` indirectly |

---

## Instruction Categories

Every program exposes instructions in one of three categories:

| Category | Caller | Auth check |
|---|---|---|
| **Management** | Deployer | `verify_deployer()` + optional `require_not_paused()` / `require_active()` |
| **Operational** | Token holders / participants | Program-specific access controls |
| **Auxiliary** | Other programs via CPI only | Requires a specific known PDA as `Signer` (only the authorized program can produce it via `invoke_signed`) |

Auxiliary instructions cannot be called by any external wallet. `block_account` / `unblock_account` in `freeze` accept three callers: `mint_authority` (mint), `permanent_delegate` (operations), and `transfer` (transfer).

---

## PDA Seed Reference

| Seeds | Owner | Purpose |
|---|---|---|
| `["mint_owner", mint]` | `deploy` | Stores deployer + bump; type `common::state::MintOwner` |
| `["temp_mint_authority", mint]` | `deploy` | Ephemeral signing key during `deploy_mint` only |
| `["mint_authority", mint]` | `mint` | Token-2022 mint authority |
| `["metadata_update_authority", mint]` | `metadata-update` | Token-2022 metadata update authority |
| `["freeze_authority", mint]` | `freeze` | Token-2022 freeze authority |
| `["frozen_account", mint, account]` | `freeze` | Marker: account fully frozen at CMTAT level |
| `["frozen_balance", mint, account]` | `freeze` | Stores locked balance for partial freeze |
| `["permanent_delegate", mint]` | `operations` | Token-2022 PermanentDelegate authority |
| `["pausable_authority", mint]` | `pause` | Token-2022 Pausable authority |
| `["deactivate", mint]` | `deactivate` | Marker: mint permanently deactivated |
| `["transfer_control_mode", mint]` | `transfer-control` | Stores `is_clearing` flag |
| `["whitelist", mint, account]` | `transfer-control` | Marker: account is whitelisted |
| `["transfer", mint]` | `transfer` | Transfer authority; signs freeze/thaw CPIs |
| `["transfer_hook_authority", mint]` | `transfer-hook` | Token-2022 TransferHook extension authority |
| `["extra-account-metas", mint]` | `transfer-hook` | SPL ExtraAccountMetaList for the hook |

Always use `seeds::program` when referencing a PDA owned by another program:
```rust
#[account(seeds = [b"mint_owner", mint.key().as_ref()], seeds::program = constants::DEPLOY_PROGRAM_ID, bump)]
pub mint_owner_pda: UncheckedAccount<'info>,
```

---

## Token-2022 Extensions

| Extension | Authority PDA seeds | Owner program | Behaviour |
|---|---|---|---|
| `PermanentDelegate` | `["permanent_delegate", mint]` | `operations` | Burn/transfer from any account |
| `MetadataPointer` | None (immutable) | — | Points to mint itself |
| `Pausable` | `["pausable_authority", mint]` | `pause` | Pause/unpause all Token-2022 operations |
| `DefaultAccountState(Frozen)` | `["freeze_authority", mint]` | `freeze` | All new accounts start frozen; thawed/re-frozen transiently during mint/burn/transfer |
| `TokenMetadata` | `["metadata_update_authority", mint]` | `metadata-update` | Embedded name/symbol/URI + custom fields |
| `TransferHook` | `["transfer_hook_authority", mint]` | `transfer-hook` | Invokes `transfer-hook::execute` on every `transfer_checked` |

---

## Checklist: Adding a New Program

1. Create `programs/<name>/` with the standard structure.
2. `constants.rs`: `pub use deploy::ID as DEPLOY_PROGRAM_ID;` (or hardcode if circular dep).
3. Add to `Anchor.toml` `[workspace]` members and `[programs.localnet]`.
4. Implement instructions following the correct category pattern above.
5. If the program owns a Token-2022 extension authority PDA: wire it into `deploy` (add crate dep with `cpi` feature, export ID in `constants.rs`, add authority PDA to `DeployMint` accounts, call the extension initializer CPI).
6. Add `tests/<name>.ts` with a `deployMint()` helper.
7. Create `docs/<name>.md` and link it below.

## Keeping Docs in Sync

| Change | Update |
|---|---|
| New program | `docs/<name>.md` + link below + `CLAUDE.md` tables |
| New / modified instruction | relevant `docs/` file |
| Program ID changed | Program IDs table + relevant `docs/` file + any hardcoded constants |
| New PDA | PDA Seed Reference table |

---

## Detailed Program References

- [`docs/common.md`](docs/common.md)
- [`docs/deploy.md`](docs/deploy.md)
- [`docs/mint.md`](docs/mint.md)
- [`docs/metadata-update.md`](docs/metadata-update.md)
- [`docs/freeze.md`](docs/freeze.md)
- [`docs/operations.md`](docs/operations.md)
- [`docs/pause.md`](docs/pause.md)
- [`docs/deactivate.md`](docs/deactivate.md)
- [`docs/transfer-control.md`](docs/transfer-control.md)
- [`docs/transfer.md`](docs/transfer.md)
- [`docs/transfer-hook.md`](docs/transfer-hook.md)
