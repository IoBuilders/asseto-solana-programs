# Asseto Solana Programs — Project Context

## Purpose

Modular multi-program Anchor workspace extending Token-2022 for compliant token issuance. Each extension is governed by a dedicated program owning a PDA authority for it.

---

## Skills

This project ships task recipes in `.claude/skills/`. **Before starting any task that matches one of these — list the folder and read the matching `SKILL.md` first**, even if the session was launched from a parent directory and Claude Code didn't auto-load them.

| Skill | Use when |
|---|---|
| [`add-new-program`](.claude/skills/add-new-program/SKILL.md) | Adding a new program (crate scaffold, Anchor.toml + program-id keypair, constants, CPI wiring, docs). |
| [`add-new-instruction`](.claude/skills/add-new-instruction/SKILL.md) | Adding a new instruction to an existing program. |
| [`write-tests`](.claude/skills/write-tests/SKILL.md) | Writing or updating the `.ts` test file for a program. |

---

## Code Structure

```
asseto-solana-programs/
├── Anchor.toml               — program IDs (localnet) + test runner config
├── Cargo.toml                — workspace root (glob: programs/*)
├── programs/
│   ├── common/               — shared library: no program ID, no entrypoint
│   ├── deploy/               — deploys mints; records deployer; bootstraps the deployer's `ROLE_ADMIN` via a CPI to `access-control::initialize`
│   ├── mint/                 — controls token minting
│   ├── metadata-update/      — controls metadata updates
│   ├── freeze/               — controls freeze/thaw (block/unblock + management freeze)
│   ├── operations/           — burn via permanent delegate
│   ├── pause/                — pause/unpause the mint
│   ├── deactivate/           — permanently deactivate the mint
│   ├── transfer-control/     — whitelist / clearing mode
│   ├── transfer/             — custom transfer endpoint: `verify_transfer` (compliance pre-check) + `transfer` (unblock → transfer_checked → re-block)
│   ├── transfer-hook/        — SPL Transfer Hook; double-introspection gate (prev = verify_transfer, curr = transfer / transfer_checked) + snapshot updates
│   ├── snapshot/             — snapshot counter + total-supply / holder-balance histories per mint + one immutable Merkle-root PDA per snapshot (`take_snapshot(merkle_root)`)
│   ├── bond/                 — typed PDA exposing on-chain-readable bond terms (interest rate, par value, min denomination, issuance date, day-count)
│   ├── coupon/               — coupon issuance: increments coupon counter + CPIs `take_snapshot` + records `(snapshot_id, payment_date)` per coupon
│   ├── treasury/             — coupon payouts: stores per-mint payment-token config + `pay_coupon` (transfer_checked from treasury TA, signed by `treasury_authority` PDA)
│   ├── factory/              — singleton config PDA: `initialize` (records manager + pause flag) + two-step manager handover (`nominate_manager` → `accept_nomination` / `cancel_nomination`); per-`config_id` asset classes via `create_asset_class` + two-step asset-class owner handover (`nominate_asset_class_owner` → `accept_asset_class_ownership` / `cancel_asset_class_ownership`); multi-step asset-class version deploy (`init_asset_class_version` → `enable_asset_class_version_functionalities` / `disable_asset_class_version_functionalities` → `finalize_asset_class_version`) storing a large functionality bit-mask
│   └── access-control/       — per-mint role bit-mask: `initialize` (auxiliary, CPI-only from `deploy`) bootstraps the deployer's `Roles` PDA with `ROLE_ADMIN`; `grant_roles` / `revoke_roles` set/clear role bits for an `(mint, account)` pair; grant/revoke are admin-gated (signer must hold `ROLE_ADMIN`) + functionality-gated, only while not paused / not deactivated
└── tests/                    — one .ts file per program
```

Each program:
```
programs/<name>/src/
├── lib.rs           — declare_id!, mod declarations, #[program] impl, pub use common::program_ids::*
├── errors.rs        — #[error_code] enum (if needed)
├── state.rs / state/ — on-chain account structs (if needed)
└── instructions/
    ├── mod.rs
    └── <instruction>.rs
```

Exception: `transfer-hook` also has `constants.rs` for instruction discriminators (not program IDs).

**`common`**: shared library crate (no program ID, no entrypoint). All cross-program shared logic lives here:
- `program_ids` — all 16 program IDs as `Pubkey` constants (`DEPLOY_PROGRAM_ID`, `MINT_PROGRAM_ID`, …). Re-exported at each program's crate root via `pub use common::program_ids::*;`. Instructions reference them with `use common::program_ids as constants;`.
- `state::MintOwner` — struct for the `mint_owner_pda` created by `deploy`; defined here so downstream programs avoid importing `deploy`. Uses `#[derive(AnchorSerialize, AnchorDeserialize)]` (not `#[account]`, which requires `declare_id!`). `deploy` defines its own `#[account] MintOwner` wrapping the same fields for `Account<MintOwner>` usage.
- `require_active()` — checks that the `deactivate_pda` account is empty (mint not deactivated).
- `require_not_paused()` — parses the `PausableConfig` extension of the mint and errors if paused.
- `bitmask` — generic `[u8; N]` bit-mask primitives (`set_bits` / `clear_bits` / `is_set`) reused by every program with a bit-mask (`factory` functionalities, `access-control` roles, `require_functionality`). Bounds are derived from the mask slice length; only the shared `MASK_CHUNK_BITS = 8` lives here — per-domain capacities (`FUNCTIONALITIES_BITS_MASK`, `ROLES_BITS_MASK`) stay with their structs.
- `roles` — flat append-only `u16` role ids (`ROLE_ADMIN = 0` … `ROLE_CUSTOM_DATA_MANAGER = 9`) + `ROLES_MASK_OFFSET`; mirror of `functionalities` for `access-control`. Beyond `access-control`'s own `ROLE_ADMIN` gating, management instructions in other programs are role-gated too (`pause`/`unpause` → `ROLE_PAUSER`; `freeze` management → `ROLE_FREEZE_MANAGER`; `metadata-update` → `ROLE_CUSTOM_DATA_MANAGER`). A unit test asserts ids are sequential from 0.
- `require_role()` — checks an `access-control` `Roles` PDA has a given role bit; takes a `Ref<Roles>` from the caller's `AccountLoader<common::state::Roles>` (zero-copy typed load, same as `require_functionality`) and reads `.mask` via `bitmask::is_set`; errors `MissingRole` if the bit is unset, `RoleOutOfBounds` if the role id exceeds the mask. `common::state::Roles` is a field-for-field mirror of `access-control::state::Roles` (discriminator + size guarded by compile-time asserts in `access-control`), so `common` can load it without a circular dep. Note: an absent PDA now fails at account resolution (`AccountOwnedByWrongProgram`), not with `MissingRole`.

---

## Program IDs

| Program | ID |
|---|---|
| `deploy` | `HCe5Um7ThFBzDSyn256EPQvyr6jy6E66ydzZ5hMta3Tq` |
| `mint` | `BgVv7zYbf3L4ECwaeNoNqD6unKWvQtgTwRJ2Dma7iSHQ` |
| `metadata-update` | `iShebeGRBZYSBMQYGAg8DbLnbaW2eDvX1Zt8EG9G1ZV` |
| `freeze` | `8L1kqDvAYC9dQXNNNnZbABtRbHGjzoxSgAPzbQZmwmSd` |
| `operations` | `BHDyg8PeUyVBpmkcjYLdnt3VCmYf4wp8Xeu6TXREiLKp` |
| `pause` | `5j3F89fmVVusjwy9z3Rv5wLaVj4ovhwctQ7TRBsxNghq` |
| `deactivate` | `H2iRjVVKsKQMAnJKqiTfW2LGvT1G9tDqQ81DzRjxfX7V` |
| `transfer-control` | `3h92PdZJB7TuCzp6iPDtrJm2k8V7fn5ETYNwCYiYy9Eo` |
| `transfer` | `Fa5VLqopKp6cokXJreYeNNmUG8F9AaE4CUBnGQvtdq7Q` |
| `transfer-hook` | `2qjsucJfrjP93FCwnYjc9EjYzYS8u31eWHhQo1jR9pcg` |
| `snapshot` | `hgUtrpstViwxutrkoVXwQh3GQC18wHAmuAvYFTNiV2M` |
| `bond` | `8opYXiWzWBrUEr5vtcvaX1ybzYaMKrndxkW1U9Patk46` |
| `coupon` | `CGQMgamBMtJ97CCMwVD9v5vAYVzFsXLy8beN8Ej6t3FK` |
| `treasury` | `G71RRNtr2PLZ9Tbmp9CKnxghf3aMoasUwLGPb2u7BytA` |
| `factory` | `FEY9E77nH7R1gLGNxkhYKchJpB6MgpMrWMhkNXrNhzR5` |
| `access-control` | `GpyjQqBWux3JYqxKCXFrDbWZmhFWBJWVaVivkBW2DL2w` |

### ID sharing pattern

All program IDs are defined once in `common/src/program_ids.rs` using the `pubkey!()` macro. Each program re-exports them at the crate root in `lib.rs`:

```rust
pub use common::program_ids::*;
```

Instructions reference IDs via:

```rust
use common::program_ids as constants;
// …
seeds::program = constants::FREEZE_PROGRAM_ID,
```

**When a program ID changes:** update the value in `common/src/program_ids.rs` only.

---

## Instruction Categories

Every program exposes instructions in one of three categories:

| Category | Caller | Auth check |
|---|---|---|
| **Management** | Any authority holding the relevant role | `require_role()` against the caller's own `access-control` `Roles` PDA + optional `require_not_paused()` / `require_active()` |
| **Operational** | Token holders / participants | Program-specific access controls |
| **Auxiliary** | Other programs via CPI only | Requires a specific known PDA as `Signer` (only the authorized program can produce it via `invoke_signed`) |

Auxiliary instructions cannot be called by any external wallet. `block_account` / `unblock_account` in `freeze` accept three callers: `mint_authority` (mint), `permanent_delegate` (operations), and `transfer` (transfer). `take_snapshot` in `snapshot` accepts only one caller: `coupon_authority` (coupon) — every snapshot is anchored to a coupon. `initialize` in `access-control` accepts only one caller: the `temp_mint_authority` PDA (deploy) — the admin bootstrap runs exactly once, during `deploy_mint`.

---

## PDA Seed Reference

| Seeds | Owner | Purpose |
|---|---|---|
| `["mint_owner", mint]` | `deploy` | Stores deployer + asset-class PDA seed (`asset_class_config_id`, `asset_class_version_id`) + bump; type `common::state::MintOwner` |
| `["temp_mint_authority", mint]` | `deploy` | Ephemeral signing key during `deploy_mint` only |
| `["mint_authority", mint]` | `mint` | Token-2022 mint authority |
| `["metadata_update_authority", mint]` | `metadata-update` | Token-2022 metadata update authority |
| `["freeze_authority", mint]` | `freeze` | Token-2022 freeze authority |
| `["frozen_account", mint, account]` | `freeze` | Marker: account fully frozen |
| `["frozen_balance", mint, account]` | `freeze` | Stores locked balance for partial freeze |
| `["permanent_delegate", mint]` | `operations` | Token-2022 PermanentDelegate authority |
| `["pausable_authority", mint]` | `pause` | Token-2022 Pausable authority |
| `["deactivate", mint]` | `deactivate` | Marker: mint permanently deactivated |
| `["transfer_control_mode", mint]` | `transfer-control` | Stores `is_clearing` flag |
| `["whitelist", mint, account]` | `transfer-control` | Marker: account is whitelisted |
| `["transfer", mint]` | `transfer` | Transfer authority; signs freeze/thaw CPIs |
| `["transfer_hook_authority", mint]` | `transfer-hook` | Token-2022 TransferHook extension authority; also the payer + calling-authority for snapshot CPIs during a transfer |
| `["extra-account-metas", mint]` | `transfer-hook` | SPL ExtraAccountMetaList for the hook |
| `["snapshot_counter", mint]` | `snapshot` | Id of the **next** snapshot for the mint (0-based; after N snapshots `count == N`). Created by `take_snapshot` |
| `["snapshot_totalsupply", mint]` | `snapshot` | `SnapshotHistory` of total supply (one entry per snapshot id) |
| `["snapshot_holderbalance", mint, token_account]` | `snapshot` | `SnapshotHistory` of that holder's balance |
| `["snapshot_merkle_root", mint, snapshot_id]` | `snapshot` | Immutable `SnapshotMerkleRoot` (32-byte Merkle root of `(account, balance)` leaves) — one per snapshot, created by `take_snapshot` |
| `["bond_terms", mint]` | `bond` | Typed `BondTerms` PDA (interest rate, par value, min denomination, issuance date, day-count) |
| `["coupon_authority", mint]` | `coupon` | Signing key for the `take_snapshot` CPI |
| `["coupon_counter", mint]` | `coupon` | `CouponCounter` PDA — strictly-increasing coupon id per mint |
| `["coupon", mint, coupon_id]` | `coupon` | Per-coupon record: snapshot id at issuance + payment date |
| `["treasury_config", mint]` | `treasury` | Stores the Token-2022 *payment* mint pubkey + cached decimals used by `pay_coupon` |
| `["treasury_authority", mint]` | `treasury` | Owner of the treasury's payment-mint token account; signs `transfer_checked` during `pay_coupon` |
| `["coupon_paid", mint, coupon_id, holder_token_account]` | `treasury` | Marker created by `pay_coupon`; existence prevents double-payment of the same `(coupon, holder)` pair |
| `["factory"]` | `factory` | Singleton `Factory` config PDA (manager pubkey + pause flag); created once by `initialize` |
| `["factory_pending_manager"]` | `factory` | Singleton `FactoryPendingManager` PDA (nominated manager); created/updated by `nominate_manager`, removed by `accept_nomination` / `cancel_nomination` |
| `["asset_class_ownership", config_id]` | `factory` | Per-`config_id` `AssetClassOwnership` PDA (owner + latest_version); created by `create_asset_class`, `owner` updated by `accept_asset_class_ownership` |
| `["asset_class_pending_owner", config_id]` | `factory` | Per-`config_id` `AssetClassPendingOwner` PDA (nominated owner); created/updated by `nominate_asset_class_owner`, removed by `accept_asset_class_ownership` / `cancel_asset_class_ownership` |
| `["asset_class_version", config_id, version]` | `factory` | Per-version `AssetClassVersion` PDA — **zero-copy**, fixed-capacity `[u8; FUNCTIONALITIES_BYTES_MASK]` functionality bit-mask + state; created `Draft` by `init_asset_class_version` with an empty (all-zero) mask (each version is independent — nothing inherited from the previous one), bits freely turned on/off by `enable_asset_class_version_functionalities` / `disable_asset_class_version_functionalities` while `Draft`, sealed `Ready` (immutable) by `finalize_asset_class_version` |
| `["roles", mint, account]` | `access-control` | Per-`(mint, account)` `Roles` PDA — **zero-copy**, fixed-capacity `[u8; ROLES_BYTES_MASK]` role bit-mask; bit `i` = role `i` granted. Bootstrapped for the deployer by `initialize` (CPI from `deploy_mint`, grants `ROLE_ADMIN`); created/updated by `grant_roles` (sets bits), cleared by `revoke_roles`. Seeds are the `"roles"` prefix (`pda_seeds::ROLES`) + the raw `mint` + `account` pubkeys. The same PDA at `["roles", mint, authority]` doubles as the role-check account, loaded as `AccountLoader<Roles>` and read by `require_role`. Mirrored by `common::state::Roles` so `common` can load it without depending on `access-control` |

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
| `TransferHook` | `["transfer_hook_authority", mint]` | `transfer-hook` | Invokes `transfer-hook::execute` on every `transfer_checked`. The hook runs a double introspection check (previous top-level instruction must be `transfer::verify_transfer`; current top-level must be `transfer::transfer` or `Token-2022::transfer_checked`, both with matching args), then updates the sender/receiver snapshot entries. Compliance rules (deactivation, transfer-mode, whitelist, frozen account, frozen balance) live in `transfer::verify_transfer`, not in the hook — see [`docs/transfer-hook-heap-oom.md`](docs/transfer-hook-heap-oom.md) for why. |

---

## Keeping Docs in Sync

| Change | Update |
|---|---|
| New program | `docs/<name>.md` + link below + `CLAUDE.md` tables |
| New / modified instruction | relevant `docs/` file |
| Program ID changed | `common/src/program_ids.rs` + Program IDs table + relevant `docs/` file |
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
- [`docs/snapshot.md`](docs/snapshot.md)
- [`docs/bond.md`](docs/bond.md)
- [`docs/coupon.md`](docs/coupon.md)
- [`docs/treasury.md`](docs/treasury.md)
- [`docs/factory.md`](docs/factory.md)
- [`docs/access-control.md`](docs/access-control.md)
- [`docs/transfer-hook-heap-oom.md`](docs/transfer-hook-heap-oom.md) — background on the 32 KiB Token-2022 heap limit that drove the verify_transfer + introspection design
