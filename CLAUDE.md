# Asseto Solana Programs — Project Context

## Purpose

Modular multi-program Anchor workspace extending Token-2022 for compliant token issuance. Each extension is governed by a dedicated program owning a PDA authority for it.

---

## Code Comments

`docs/*.md` (and this file) are the source of truth for *what* a program or instruction does and *why* its accounts are shaped the way they are. Code comments are for the *why*, not the *what* — this applies to every edit in this repo, not just when a skill below is invoked.

- **Don't** add a comment that restates the identifier/type/seeds already visible at the point of use — e.g. `/// The Token-2022 mint.` above `pub mint: UncheckedAccount<'info>`, or a function-level `///` doc that repeats what `docs/<program>.md` already says about that instruction. If you're about to write a comment, ask whether a reader could get the same information by reading the code one line further — if yes, don't write it.
- **Do** keep a comment when it encodes something the compiler won't enforce and the docs don't already state at the point of use — a load-bearing invariant (e.g. account ordering the transfer hook depends on), a non-obvious arithmetic/padding/alignment rationale, or a workaround for a specific runtime constraint (BPF stack/heap limits, etc.).
- **Always** keep the `/// CHECK:` comment on every `UncheckedAccount` field explaining how its safety is established (seeds constraint, runtime check, Token-2022 CPI, etc.) — this is Anchor's own convention, not something to prune.
- Section-marker comments inside a handler body (`// ── Auth checks ──`) are fine to keep or drop at your judgement — they're navigational, not explanatory duplication.
- Before trimming an existing comment, check whether the information it carries is already in `docs/<program>.md`; if not, add it there first, then delete the code comment. Every instruction's doc section should open with a plain-language sentence describing what it does — not jump straight to a parameter/account table — even if that sentence doesn't exist yet and you have to add it.

See `.claude/skills/add-new-instruction/SKILL.md` §5/§9 for the fuller reference (account-struct conventions and worked examples) when actively adding a new instruction.

---

## Rust / Anchor Conventions

- **Never deserialize an account via `T::try_deserialize`/`try_deserialize_unchecked` directly** to turn a raw `AccountInfo`/`UncheckedAccount` into a typed struct. Always go through `Account::<T>::try_from(&account_info)` (or `AccountLoader::<T>::try_from` for zero-copy types). `try_deserialize` only checks the account's 8-byte discriminator; `try_from` checks that *and* that `info.owner == T::owner()` (plus the not-initialized case) before ever calling `try_deserialize`. Skipping `try_from` is the classic Solana "missing owner check" vulnerability — an attacker-controlled account with fabricated bytes matching the discriminator would deserialize and be trusted as if it were the real PDA. See `docs/common.md`'s "Working with `AccountInfo` parameters" section for the full writeup, including the related lifetime requirement `try_from` imposes on its input.

---

## Development Commands

Toolchain versions are pinned (`rust-toolchain.toml`, `Anchor.toml` `[toolchain]`) — Rust `1.89.0`, Solana CLI `3.1.14`, Anchor CLI `1.0.2`, Surfpool `1.3.0` (local validator), Node `24.16`.

```bash
# Build every program in the workspace, regenerate IDLs/types under target/
anchor build

# Rust unit tests
cargo test

# Full TypeScript integration suite (boots a local Surfpool validator per Anchor.toml [surfpool])
anchor test

# Single suite — TEST_FILE = filename under tests/ without .ts (requires a prior `anchor build`)
TEST_FILE=<name> anchor test --skip-build

# Single test by name within a suite — GREP = substring of the "describe + it" title
TEST_FILE=<name> GREP="<partial test name>" anchor test --skip-build

# TS/JS lint
npm run lint       # check
npm run lint:fix   # write
```

Program IDs stay stable across builds via committed keypairs (`target/deploy/*-keypair.json`). Each program's `declare_id!` must match its keypair — verify with `anchor keys list`, fix drift with `anchor keys sync`.

A funded local wallet is required once for tests: `solana-keygen new --no-bip39-passphrase --force -o test-wallet.json` (path referenced by `Anchor.toml` as the provider wallet).

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
│   ├── deploy/               — deploys mints; records the asset-class config/version ids in `asset_configuration_pda`; bootstraps the deployer's `ROLE_ADMIN` via a CPI to `access-control::initialize`
│   ├── mint/                 — controls token minting; `mint` (single destination, snapshot-integrated) + `batch_mint` (multiple destinations via `remaining_accounts`, not snapshot-integrated). Both enforce the `cap` supply cap before issuing
│   ├── metadata-update/      — controls metadata updates
│   ├── freeze/               — management freeze/unfreeze (full + partial), expressed purely as marker PDAs; enforced read-side by `transfer-hook::execute`, no Token-2022 CPI
│   ├── operations/           — permanent-delegate operations: burn (`burn` + `batch_burn`, co-signed by the `permissioned_burn` PDA), force-transfer (`controller_transfer`) + `hold_transfer` (auxiliary, CPI-only from `hold`)
│   ├── pause/                — pause/unpause the mint
│   ├── deactivate/           — permanently deactivate the mint
│   ├── transfer-control/     — whitelist mode: `initialize` sets the mode, `add_to_whitelist` / `remove_from_whitelist` manage per-account markers
│   ├── transfer/             — a single instruction, `batch_transfer` (one source holder → N destinations via `remaining_accounts`, 2 accounts per leg); the singular path has no instruction here at all — the client submits Token-2022's own `transfer_checked` with the hook's accounts appended. No compliance logic: it only forwards the hook block per leg
│   ├── transfer-hook/        — SPL Transfer Hook; read-only gate holding the whole compliance suite (deactivation, transfer-mode/whitelist, frozen account, post-debit cover of the partial-freeze **and** hold liens) + `TRANSFER_HOOK_EXECUTE` functionality check. No introspection, no sysvar; bypasses every check when the authority is the `permanent_delegate` PDA. Writes nothing
│   ├── snapshot/             — snapshot counter + one immutable Merkle-root PDA per snapshot (`take_snapshot(merkle_root)`)
│   ├── bond/                 — typed PDA exposing on-chain-readable bond terms (interest rate, par value, min denomination, issuance date, day-count)
│   ├── coupon/               — coupon issuance: increments coupon counter + CPIs `take_snapshot` + records `(snapshot_id, payment_date)` per coupon
│   ├── treasury/             — coupon payouts: stores per-mint payment-token config + `pay_coupon` (Merkle-proves the holder's snapshot balance, then transfer_checked from treasury TA, signed by `treasury_authority` PDA)
│   ├── factory/              — singleton config PDA: `initialize` (records manager + pause flag) + two-step manager handover (`nominate_manager` → `accept_nomination` / `cancel_nomination`); per-`config_id` asset classes via `create_asset_class` + two-step asset-class owner handover (`nominate_asset_class_owner` → `accept_asset_class_ownership` / `cancel_asset_class_ownership`); multi-step asset-class version deploy (`init_asset_class_version` → `enable_asset_class_version_functionalities` / `disable_asset_class_version_functionalities` → `finalize_asset_class_version`) storing a large functionality bit-mask
│   ├── cap/                  — supply cap: `set_max_supply` records a per-mint maximum supply PDA + exports `require_within_max_supply` (linked-in check, no CPI) that `mint`/`batch_mint` call before issuing
│   ├── access-control/       — per-mint role bit-mask: `initialize` (auxiliary, CPI-only from `deploy`) bootstraps the deployer's `Roles` PDA with `ROLE_ADMIN`; `grant_roles` / `revoke_roles` set/clear role bits for an `(mint, account)` pair; grant/revoke are admin-gated (signer must hold `ROLE_ADMIN`) + functionality-gated, only while not paused / not deactivated
│   ├── document/             — ERC-1643 document management: `set_document` upserts a `["document", mint, name]` PDA (URI + integrity hash), resizing it to fit the `uri` on every call; `remove_document` closes it, refunding rent to the signer
│   └── hold/                 — ERC-1996 holds, modelled as a **lien** (tokens never move on creation): `hold_position` accumulates the held amount per `(mint, token_account)` and `transfer-hook::execute` subtracts it; `create_hold` (holder) + `controller_create_hold` (Management, `ROLE_CONTROLLER`, imposes a hold on someone else's position) + `execute_hold` / `release_hold` (escrow/notary only) + `reclaim_hold` (permissionless after expiry). Only `execute_hold` moves tokens, via a CPI to `operations::hold_transfer`. The two creation paths share `record_new_hold` in `hold::creation`. All five share the single `HOLD_CREATE_HOLD` functionality bit (the whole capability, as in EVM); pause/deactivation gate only creation and execution
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

No program has a `constants.rs`: program IDs all come from `common::program_ids`. (`transfer-hook` used to keep one for the instruction discriminators its introspection check compared against; that check is gone.)

**`common`**: shared library crate (no program ID, no entrypoint). All cross-program shared logic lives here:
- `program_ids` — all program IDs as `Pubkey` constants (`DEPLOY_PROGRAM_ID`, `MINT_PROGRAM_ID`, …). Re-exported at each program's crate root via `pub use common::program_ids::*;`. Instructions reference them with `use common::program_ids as constants;`.
- `state::AssetConfiguration` — struct for the `asset_configuration_pda` created by `deploy`; defined here so downstream programs avoid importing `deploy`. Uses `#[derive(AnchorSerialize, AnchorDeserialize)]` (not `#[account]`, which requires `declare_id!`). `deploy` defines its own `#[account] AssetConfiguration` wrapping the same fields for `Account<AssetConfiguration>` usage.
- `hook_accounts` — `HookAccounts`, the 17 accounts every `transfer_checked` on an Asseto mint must append so Token-2022 can resolve and invoke the hook, in wire order, plus `append_metas` / `append_infos`. The field order **is** the metalist order and is load-bearing; keeping it here rather than at each call site (`transfer::batch_transfer`, `operations::controller_transfer`, `operations::hold_transfer`) means growing the metalist is one edit instead of three.
- `require_active()` — checks that the `deactivate_pda` account is empty (mint not deactivated).
- `require_not_paused()` — parses the `PausableConfig` extension of the mint and errors if paused.
- `functionalities` — flat append-only `u16` ids, one per instruction across the whole workspace (`BOND_UPDATE_BOND_TERMS = 0` … `HOLD_CREATE_HOLD = 26`), excluding `factory` itself. A unit test asserts ids are sequential from 0.
- `require_functionality()` — checks a `factory` `AssetClassVersion`'s mask has a given functionality bit set; takes a `Ref<AssetClassVersion>` from the caller's `AccountLoader<common::state::AssetClassVersion>` (zero-copy typed load) and reads `.mask` via `bitmask::is_set`; errors `AssetClassVersionNotFinalized` if the version isn't sealed `Ready`, `FunctionalityNotSupportedError` if the bit is unset, `FunctionalityOutOfBounds` if the functionality id exceeds the mask.
- `bitmask` — generic `[u8; N]` bit-mask primitives (`set_bits` / `clear_bits` / `is_set`) reused by every program with a bit-mask (`factory` functionalities, `access-control` roles, `require_functionality`). Bounds are derived from the mask slice length; only the shared `MASK_CHUNK_BITS = 8` lives here — per-domain capacities (`FUNCTIONALITIES_BITS_MASK`, `ROLES_BITS_MASK`) stay with their structs.
- `roles` — flat append-only `u16` role ids (`ROLE_ADMIN = 0` … `ROLE_CAP = 10`) + `ROLES_MASK_OFFSET`; mirror of `functionalities` for `access-control`. Beyond `access-control`'s own `ROLE_ADMIN` gating, management instructions in other programs are role-gated too (`pause`/`unpause` → `ROLE_PAUSER`; `freeze` management → `ROLE_FREEZE_MANAGER`; `metadata-update` → `ROLE_CUSTOM_DATA_MANAGER`; `cap::set_max_supply` → `ROLE_CAP`; `operations::controller_transfer` and `hold::controller_create_hold` → `ROLE_CONTROLLER`). A unit test asserts ids are sequential from 0.
- `require_role()` — checks an `access-control` `Roles` PDA has a given role bit; takes a `Ref<Roles>` from the caller's `AccountLoader<common::state::Roles>` (zero-copy typed load, same as `require_functionality`) and reads `.mask` via `bitmask::is_set`; errors `MissingRole` if the bit is unset, `RoleOutOfBounds` if the role id exceeds the mask. `common::state::Roles` is a field-for-field mirror of `access-control::state::Roles` (discriminator + size guarded by compile-time asserts in `access-control`), so `common` can load it without a circular dep. Note: an absent PDA now fails at account resolution (`AccountOwnedByWrongProgram`), not with `MissingRole`.
- `merkle` — Merkle-proof verification for snapshot balances. `verify_balance_proof(proof, root, account, balance) -> bool` folds a **sorted-pair** (commutative) proof up from `leaf_hash = keccak(account || balance.to_le_bytes())` and checks it equals `root`; `LeafData { account, amount }` + `leaf_hash()` help build leaves. Only leaf existence is proven, not position. Uses `solana-keccak-hasher` (syscall on the `solana` target; `sha3` feature gives a host impl for unit tests). Consumed by `treasury::pay_coupon` to validate a holder's balance against a snapshot's Merkle root.

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
| `cap` | `64THHYmfoHeWxbZQYq8yRsQJYydfd7yPa6MzNgebiJLm` |
| `document` | `DzYjHw2JUBT8RdNqT8P5soRxJhmL6obibRUs5sMJ2Khi` |
| `hold` | `J8iq5Qz8tXLswZBbUFHuJukf3jpwEXLGVpvFoPZb2qY3` |

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

**When a program ID changes:** it's a literal in three places — update all of them: `declare_id!` in the program's own `src/lib.rs`, the workspace `Anchor.toml`, and the constant in `common/src/program_ids.rs`.

---

## Instruction Categories

Every program exposes instructions in one of three categories:

| Category | Caller | Auth check |
|---|---|---|
| **Management** | Any authority holding the relevant role | `require_role()` against the caller's own `access-control` `Roles` PDA + optional `require_not_paused()` / `require_active()` |
| **Operational** | Token holders / participants | Program-specific access controls |
| **Auxiliary** | Other programs via CPI only | Requires a specific known PDA as `Signer` (only the authorized program can produce it via `invoke_signed`) |

Auxiliary instructions cannot be called by any external wallet. `take_snapshot` in `snapshot` accepts only one caller: `coupon_authority` (coupon) — every snapshot is anchored to a coupon. `initialize` in `access-control` accepts only one caller: the `temp_mint_authority` PDA (deploy) — the admin bootstrap runs exactly once, during `deploy_mint`. `hold_transfer` in `operations` accepts only one caller: the `hold_authority` PDA (hold) — it is the permanent delegate's signing path for a hold execution and runs **no** compliance checks of its own, because `hold::execute_hold` has already run them.

---

## PDA Seed Reference

| Seeds | Owner | Purpose |
|---|---|---|
| `["asset_configuration", mint]` | `deploy` | Stores the asset-class PDA seed (`asset_class_config_id`, `asset_class_version_id`) + bump; type `common::state::AssetConfiguration` |
| `["temp_mint_authority", mint]` | `deploy` | Ephemeral signing key during `deploy_mint` only |
| `["mint_authority", mint]` | `mint` | Token-2022 mint authority |
| `["metadata_update_authority", mint]` | `metadata-update` | Token-2022 metadata update authority |
| `["frozen_account", mint, account]` | `freeze` | Marker: account fully frozen |
| `["frozen_balance", mint, account]` | `freeze` | Stores locked balance for partial freeze |
| `["permanent_delegate", mint]` | `operations` | Token-2022 PermanentDelegate authority |
| `["permissioned_burn", mint]` | `operations` | Token-2022 PermissionedBurn authority; co-signs every burn alongside `permanent_delegate` |
| `["pausable_authority", mint]` | `pause` | Token-2022 Pausable authority |
| `["deactivate", mint]` | `deactivate` | Marker: mint permanently deactivated |
| `["transfer_control_mode", mint]` | `transfer-control` | Stores the active `TransferMode` (currently only `Whitelist`) + bump; created once by `initialize` (no close/update path) |
| `["whitelist", mint, account]` | `transfer-control` | Marker: account is whitelisted |
| `["transfer_hook_authority", mint]` | `transfer-hook` | Token-2022 TransferHook extension authority (set on the mint by `deploy_mint`); not passed to `execute` and never used as a signer |
| `["extra-account-metas", mint]` | `transfer-hook` | SPL ExtraAccountMetaList for the hook |
| `["snapshot_counter", mint]` | `snapshot` | Id of the **next** snapshot for the mint (0-based; after N snapshots `count == N`). Created by `take_snapshot` |
| `["snapshot_merkle_root", mint, snapshot_id]` | `snapshot` | Immutable `SnapshotMerkleRoot` (32-byte Merkle root of `(account, balance)` leaves) — one per snapshot, created by `take_snapshot` |
| `["bond_terms", mint]` | `bond` | Typed `BondTerms` PDA (interest rate, par value, min denomination, issuance date, day-count) |
| `["coupon_authority", mint]` | `coupon` | Signing key for the `take_snapshot` CPI |
| `["coupon_counter", mint]` | `coupon` | `CouponCounter` PDA — strictly-increasing coupon id per mint |
| `["coupon", mint, coupon_id]` | `coupon` | Per-coupon record: snapshot id at issuance + payment date |
| `["treasury_config", mint]` | `treasury` | Stores the Token-2022 *payment* mint pubkey + cached decimals used by `pay_coupon` |
| `["treasury_authority", mint]` | `treasury` | Owner of the treasury's payment-mint token account; signs `transfer_checked` during `pay_coupon` |
| `["coupon_paid", mint, coupon_id, account]` | `treasury` | Marker created by `pay_coupon`; existence prevents double-payment of the same `(coupon, holder)` pair. `account` is the `pay_coupon` argument proven against the snapshot's Merkle root, not an account in the instruction |
| `["factory"]` | `factory` | Singleton `Factory` config PDA (manager pubkey + pause flag); created once by `initialize` |
| `["factory_pending_manager"]` | `factory` | Singleton `FactoryPendingManager` PDA (nominated manager); created/updated by `nominate_manager`, removed by `accept_nomination` / `cancel_nomination` |
| `["asset_class_ownership", config_id]` | `factory` | Per-`config_id` `AssetClassOwnership` PDA (owner + latest_version); created by `create_asset_class`, `owner` updated by `accept_asset_class_ownership` |
| `["asset_class_pending_owner", config_id]` | `factory` | Per-`config_id` `AssetClassPendingOwner` PDA (nominated owner); created/updated by `nominate_asset_class_owner`, removed by `accept_asset_class_ownership` / `cancel_asset_class_ownership` |
| `["asset_class_version", config_id, version]` | `factory` | Per-version `AssetClassVersion` PDA — **zero-copy**, fixed-capacity `[u8; FUNCTIONALITIES_BYTES_MASK]` functionality bit-mask + state; created `Draft` by `init_asset_class_version` with an empty (all-zero) mask (each version is independent — nothing inherited from the previous one), bits freely turned on/off by `enable_asset_class_version_functionalities` / `disable_asset_class_version_functionalities` while `Draft`, sealed `Ready` (immutable) by `finalize_asset_class_version` |
| `["roles", mint, account]` | `access-control` | Per-`(mint, account)` `Roles` PDA — **zero-copy**, fixed-capacity `[u8; ROLES_BYTES_MASK]` role bit-mask; bit `i` = role `i` granted. Bootstrapped for the deployer by `initialize` (CPI from `deploy_mint`, grants `ROLE_ADMIN`); created/updated by `grant_roles` (sets bits), cleared by `revoke_roles`. Seeds are the `"roles"` prefix (`pda_seeds::ROLES`) + the raw `mint` + `account` pubkeys. The same PDA at `["roles", mint, authority]` doubles as the role-check account, loaded as `AccountLoader<Roles>` and read by `require_role`. Mirrored by `common::state::Roles` so `common` can load it without depending on `access-control` |
| `["max_supply", mint]` | `cap` | Typed `MaxSupply` PDA (maximum total supply in raw mint units) — created/overwritten by `set_max_supply`; read by `mint`/`batch_mint` via `cap::require_within_max_supply`. Absent = no cap |
| `["hold_position", mint, token_account]` | `hold` | Per-`(mint, token_account)` `HoldPosition` — `held_amount` (the lien the transfer hook subtracts from the spendable balance) + `hold_count` (monotonic, never reset; the next hold gets `hold_id == hold_count + 1`, so ids start at 1). Created by the account's first `create_hold` and never closed |
| `["hold", mint, token_account, hold_id]` | `hold` | Per-arrangement `Hold` (escrow/notary, optional pinned destination, initial/current amount, expiration, status). Persists in its terminal state as the on-chain audit trail |
| `["hold_authority", mint]` | `hold` | Empty PDA; signs the `operations::hold_transfer` CPI so the permanent delegate can move tokens on a hold execution |
| `["document", mint, name]` | `document` | Per-`(mint, name)` `Document` PDA (URI + integrity hash) — created and resized to fit `uri` by `set_document`, closed by `remove_document`. `mint` is stored in the account (not just the seeds) so `getProgramAccounts` + `memcmp(offset=8, mint)` can enumerate a mint's documents off-chain |

Always use `seeds::program` when referencing a PDA owned by another program:
```rust
#[account(seeds = [b"asset_configuration", mint.key().as_ref()], seeds::program = constants::DEPLOY_PROGRAM_ID, bump)]
pub asset_configuration_pda: UncheckedAccount<'info>,
```

---

## Token-2022 Extensions

| Extension | Authority PDA seeds | Owner program | Behaviour |
|---|---|---|---|
| `PermanentDelegate` | `["permanent_delegate", mint]` | `operations` | Burn/transfer from any account |
| `MetadataPointer` | None (immutable) | — | Points to mint itself |
| `Pausable` | `["pausable_authority", mint]` | `pause` | Pause/unpause all Token-2022 operations |
| `PermissionedBurn` | `["permissioned_burn", mint]` | `operations` | Burning requires this authority as an extra signer, so the plain Token-2022 `Burn` is rejected and `operations::burn` / `batch_burn` are the only burn path |
| `TokenMetadata` | `["metadata_update_authority", mint]` | `metadata-update` | Embedded name/symbol/URI + custom fields |
| `TransferHook` | `["transfer_hook_authority", mint]` | `transfer-hook` | Invokes `transfer-hook::execute` on every `transfer_checked`. The hook holds the full compliance suite (deactivation, transfer-mode, whitelist, frozen account, post-debit cover of the partial-freeze and hold liens) plus the `TRANSFER_HOOK_EXECUTE` functionality check, and writes nothing. It reads no `Instructions` sysvar, so every path (bare `transfer_checked`, `transfer::batch_transfer`, `operations::controller_transfer`, or a CPI from any program) is gated identically — the one exemption is the `permanent_delegate` authority, which skips every check. Its `ExtraAccountMetaList` is capped by Token-2022's 32 KiB heap — see [`docs/transfer-hook.md`](docs/transfer-hook.md#metalist-contents) before adding entries. |

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
- [`docs/cap.md`](docs/cap.md)
- [`docs/document.md`](docs/document.md)
- [`docs/hold.md`](docs/hold.md)
- [`docs/transfer-hook-heap-oom.md`](docs/transfer-hook-heap-oom.md) — background on the 32 KiB Token-2022 heap limit that drove the verify_transfer + introspection design
