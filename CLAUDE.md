# CMTAT One Atelier POC — Project Context

## Purpose

Modular multi-program Anchor workspace extending Token-2022 for CMTAT-compliant token issuance. Each extension is governed by a dedicated program owning a PDA authority for it.

---

## Skills

This project ships task recipes in `cmtat-one-atelier-poc/.claude/skills/`. **Before starting any task that matches one of these — list the folder and read the matching `SKILL.md` first**, even if the session was launched from a parent directory and Claude Code didn't auto-load them.

| Skill | Use when |
|---|---|
| [`add-new-program`](.claude/skills/add-new-program/SKILL.md) | Adding a new `cmtat-<name>` program (crate scaffold, Anchor.toml + program-id keypair, constants, CPI wiring, docs). |
| [`add-new-instruction`](.claude/skills/add-new-instruction/SKILL.md) | Adding a new instruction to an existing program. |
| [`write-tests`](.claude/skills/write-tests/SKILL.md) | Writing or updating the `.ts` test file for a program. |

---

## Code Structure

```
cmtat-one-atelier-poc/
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
│   ├── cmtat-transfer/       — custom transfer endpoint: `verify_transfer` (compliance pre-check) + `transfer` (unblock → transfer_checked → re-block)
│   ├── cmtat-transfer-hook/  — SPL Transfer Hook; double-introspection gate (prev = verify_transfer, curr = transfer / transfer_checked) + snapshot updates
│   ├── cmtat-snapshot/       — snapshot counter + total-supply / holder-balance histories per mint
│   ├── cmtat-bond/           — typed PDA exposing on-chain-readable bond terms (interest rate, par value, min denomination, issuance date, day-count)
│   ├── cmtat-coupon/         — coupon issuance: increments coupon counter + CPIs `take_snapshot` + records `(snapshot_id, payment_date)` per coupon
│   └── cmtat-treasury/       — coupon payouts: stores per-mint payment-token config + `pay_coupon` (transfer_checked from treasury TA, signed by `treasury_authority` PDA)
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
- `require_active()` — checks that the `deactivate_pda` account is empty (mint not deactivated).
- `require_not_paused()` — parses the `PausableConfig` extension of the mint and errors if paused.

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
| `cmtat-snapshot` | `BcuEispMLyXAa44oRbxjgacAJWdEhFXqrBNXQfgHnfWW` |
| `cmtat-bond` | `BLA6wUczWivPKBw7wnZbvHfYPxcRWEE2Z5aGRnTdfUcU` |
| `cmtat-coupon` | `4pvS3t8wey2MhcgTgBSZZbHRUe6EFUv2pD9jJLFKWZ6u` |
| `cmtat-treasury` | `CBxS9txE8qZqZkNXhTaWE42Ur3J3GtYv1ufLfNDNUEct` |

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
| `cmtat-transfer-hook` | `cmtat-deploy`, `cmtat-deactivate`, `cmtat-transfer` | `cmtat-transfer` depends on `cmtat-transfer-hook` (for the hook's program ID); the hook needs `cmtat-transfer`'s ID for its introspection-of-N check |
| `cmtat-snapshot` | `cmtat-coupon` | `cmtat-coupon` depends on `cmtat-snapshot` for the `take_snapshot` CPI; `cmtat-snapshot` needs `cmtat-coupon`'s ID to verify the `coupon_authority` PDA in its auxiliary auth check |

---

## Instruction Categories

Every program exposes instructions in one of three categories:

| Category | Caller | Auth check |
|---|---|---|
| **Management** | Deployer | `verify_deployer()` + optional `require_not_paused()` / `require_active()` |
| **Operational** | Token holders / participants | Program-specific access controls |
| **Auxiliary** | Other programs via CPI only | Requires a specific known PDA as `Signer` (only the authorized program can produce it via `invoke_signed`) |

Auxiliary instructions cannot be called by any external wallet. `block_account` / `unblock_account` in `cmtat-freeze` accept three callers: `mint_authority` (cmtat-mint), `permanent_delegate` (cmtat-operations), and `transfer` (cmtat-transfer). `take_snapshot` in `cmtat-snapshot` accepts only one caller: `coupon_authority` (cmtat-coupon) — every snapshot is anchored to a coupon.

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
| `["transfer_hook_authority", mint]` | `cmtat-transfer-hook` | Token-2022 TransferHook extension authority; also the payer + calling-authority for snapshot CPIs during a transfer |
| `["extra-account-metas", mint]` | `cmtat-transfer-hook` | SPL ExtraAccountMetaList for the hook |
| `["snapshot_counter", mint]` | `cmtat-snapshot` | Current snapshot index for the mint (created by `take_snapshot`) |
| `["snapshot_totalsupply", mint]` | `cmtat-snapshot` | `SnapshotHistory` of total supply (one entry per snapshot id) |
| `["snapshot_holderbalance", mint, token_account]` | `cmtat-snapshot` | `SnapshotHistory` of that holder's balance |
| `["bond_terms", mint]` | `cmtat-bond` | Typed `BondTerms` PDA (interest rate, par value, min denomination, issuance date, day-count) |
| `["coupon_authority", mint]` | `cmtat-coupon` | Signing key for the `take_snapshot` CPI |
| `["coupon_counter", mint]` | `cmtat-coupon` | `CouponCounter` PDA — strictly-increasing coupon id per mint |
| `["coupon", mint, coupon_id]` | `cmtat-coupon` | Per-coupon record: snapshot id at issuance + payment date |
| `["treasury_config", mint]` | `cmtat-treasury` | Stores the Token-2022 *payment* mint pubkey + cached decimals used by `pay_coupon` |
| `["treasury_authority", mint]` | `cmtat-treasury` | Owner of the treasury's payment-mint token account; signs `transfer_checked` during `pay_coupon` |
| `["coupon_paid", mint, coupon_id, holder_token_account]` | `cmtat-treasury` | Marker created by `pay_coupon`; existence prevents double-payment of the same `(coupon, holder)` pair |

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
| `TransferHook` | `["transfer_hook_authority", mint]` | `cmtat-transfer-hook` | Invokes `cmtat-transfer-hook::execute` on every `transfer_checked`. The hook runs a double introspection check (previous top-level instruction must be `cmtat-transfer::verify_transfer`; current top-level must be `cmtat-transfer::transfer` or `Token-2022::transfer_checked`, both with matching args), then updates the sender/receiver snapshot entries. CMTAT compliance rules themselves (deactivation, transfer-mode, whitelist, frozen account, frozen balance) live in `cmtat-transfer::verify_transfer`, not in the hook — see [`docs/transfer-hook-heap-oom.md`](docs/transfer-hook-heap-oom.md) for why. |

---

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
- [`docs/cmtat-snapshot.md`](docs/cmtat-snapshot.md)
- [`docs/cmtat-bond.md`](docs/cmtat-bond.md)
- [`docs/cmtat-coupon.md`](docs/cmtat-coupon.md)
- [`docs/cmtat-treasury.md`](docs/cmtat-treasury.md)
- [`docs/transfer-hook-heap-oom.md`](docs/transfer-hook-heap-oom.md) — background on the 32 KiB Token-2022 heap limit that drove the verify_transfer + introspection design
