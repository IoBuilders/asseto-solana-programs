# Asseto Solana Programs

## Purpose

Modular multi-program Anchor workspace extending Token-2022 for compliant token issuance. Each extension is governed by a dedicated program owning a PDA authority for it.

![image](./docs/images/AssetDesign.png)

---

## Prerequisites

The exact versions below are pinned by the toolchain config and exercised in CI — other versions may work but are unsupported.

| Tool | Version | Source of truth |
|---|---|---|
| Rust | `1.89.0` (with `rustfmt`, `clippy`) | `rust-toolchain.toml` |
| Solana CLI | `3.1.14` | `Anchor.toml` `[toolchain]` |
| Anchor CLI | `1.0.2` | `Anchor.toml` `[toolchain]` |
| Surfpool | `1.5.0` | local validator for integration tests |
| Node.js | `24.16` | `npm` is the package manager |

---

## Install

```bash
# Rust — the pinned toolchain in rust-toolchain.toml is selected automatically by rustup.
rustup component add rustfmt clippy

# Solana CLI (Anza release)
sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.14/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Anchor CLI
cargo install cargo-binstall
cargo binstall anchor-cli@1.0.2 --no-confirm

# Surfpool (local validator used by the integration tests)
curl -sSfL "https://github.com/solana-foundation/surfpool/releases/download/v1.5.0/surfpool-linux-x64.tar.gz" \
  | tar xz -C "$HOME/.cargo/bin"

# Node dependencies (TypeScript tests + lint)
npm ci
```

---

## Build

```bash
anchor build
```

Builds every program in the `[workspace]` and regenerates IDLs/types under `target/`.

During this development phase, program IDs stay stable across builds and machines with program keypairs (`target/deploy/*-keypair.json`) being committed to git.
Command `anchor build` reuses existing keypairs rather than generating new ones, so the regenerated IDLs always carry the same `address`. Each program's `declare_id!` must match its committed keypair; run `anchor keys list` to verify, and `anchor keys sync` if they drift.

---

## Test

A funded local wallet is required once (the provider wallet is `./test-wallet.json`):

```bash
solana-keygen new --no-bip39-passphrase --force -o test-wallet.json
```

```bash
# Rust unit tests
cargo test

# TypeScript integration suite (boots a local Surfpool validator per Anchor.toml [surfpool])
anchor test

# Run a single suite (TEST_FILE = filename under tests/ without .ts)
TEST_FILE=<name> anchor test --skip-build

# Run a single test by name within a suite (GREP = substring of "describe + it" title)
TEST_FILE=<name> GREP="<partial test name>" anchor test --skip-build
```

Use `--skip-build` once you've already run a fresh `anchor build`.

---

## Code Structure

```
./
├── Anchor.toml               — program IDs (localnet) + test runner config
├── Cargo.toml                — workspace root (glob: programs/*)
├── programs/
│   ├── common/               — shared library: no program ID, no entrypoint
│   ├── deploy/               — deploys mints; records deployer
│   ├── mint/                 — controls token minting
│   ├── metadata-update/      — controls metadata updates
│   ├── freeze/               — management freeze/unfreeze via marker PDAs; enforced read-side by `transfer-hook::execute`
│   ├── operations/           — burn via permanent delegate + permissioned-burn authority
│   ├── pause/                — pause/unpause the mint
│   ├── deactivate/           — permanently deactivate the mint
│   ├── transfer-control/     — whitelist / clearing mode
│   ├── transfer/             — `batch_transfer` only (one source → N destinations); the singular transfer is Token-2022's own `transfer_checked`, submitted by the client
│   ├── transfer-hook/        — SPL Transfer Hook; read-only gate holding the whole transfer compliance suite + functionality check
│   ├── snapshot/             — snapshot counter + total-supply / holder-balance histories per mint
│   ├── bond/                 — typed PDA exposing on-chain-readable bond terms
│   ├── coupon/               — coupon issuance: increments coupon counter + CPIs `take_snapshot`
│   ├── treasury/             — coupon payouts: `pay_coupon` signed by `treasury_authority` PDA
│   ├── factory/              — singleton config PDA: `initialize` (records manager + pause flag) + two-step manager handover (`nominate_manager` → `accept_nomination` / `cancel_nomination`); per-`config_id` asset classes via `create_asset_class` + two-step asset-class owner handover (`nominate_asset_class_owner` → `accept_asset_class_ownership` / `cancel_asset_class_ownership`)
│   ├── access-control/       — per-mint role bit-mask: `grant_roles` / `revoke_roles` set/clear role bits for an `(mint, account)` pair; admin-gated + functionality-gated
│   └── hold/                 — ERC-1996 holds as a lien on the holder's own balance; escrow (notary) executes or releases, anyone reclaims after expiry
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

No program has a `constants.rs`: program IDs all come from `common::program_ids`.

**`common`**: shared library crate (no program ID, no entrypoint). All cross-program shared logic lives here:
- `program_ids` — all 16 program IDs as `Pubkey` constants (`DEPLOY_PROGRAM_ID`, `MINT_PROGRAM_ID`, …). Re-exported at each program's crate root via `pub use common::program_ids::*;`. Instructions reference them with `use common::program_ids as constants;`.
- `state::MintOwner` — struct for the `mint_owner_pda` created by `deploy`; defined here so downstream programs avoid importing `deploy`. Uses `#[derive(AnchorSerialize, AnchorDeserialize)]` (not `#[account]`, which requires `declare_id!`). `deploy` defines its own `#[account] MintOwner` wrapping the same fields for `Account<MintOwner>` usage.
- `verify_deployer()` — Borsh-deserializes `MintOwner` (skipping discriminator) and checks the signer.
- `require_active()` — checks that the `deactivate_pda` account is empty (mint not deactivated).
- `require_not_paused()` — parses the `PausableConfig` extension of the mint and errors if paused.
- `require_functionality()` — checks a functionality bit in a `factory` `AssetClassVersion` (zero-copy `AccountLoader` load).
- `require_role()` — checks a role bit in an `access-control` `Roles` PDA (raw `AccountInfo` byte read); errors `MissingRole` if absent.
- `bitmask` — generic `[u8; N]` mask primitives (`set_bits` / `clear_bits` / `is_set`); shared `MASK_CHUNK_BITS = 8`, per-domain capacities stay with their structs.
- `roles` — flat `u16` role ids (`ROLE_ADMIN = 0`) + `ROLES_MASK_OFFSET`; mirror of `functionalities` for `access-control`.

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

**When a program ID changes:** update the value in `common/src/program_ids.rs` only.

---

## Instruction Categories

Every program exposes instructions in one of three categories:

| Category | Caller | Auth check |
|---|---|---|
| **Management** | Deployer | `verify_deployer()` + optional `require_not_paused()` / `require_active()` |
| **Operational** | Token holders / participants | Program-specific access controls |
| **Auxiliary** | Other programs via CPI only | Requires a specific known PDA as `Signer` (only the authorized program can produce it via `invoke_signed`) |

Auxiliary instructions cannot be called by any external wallet. `take_snapshot` in `snapshot` accepts only one caller: `coupon_authority` (coupon) — every snapshot is anchored to a coupon.

---

## PDA Seed Reference

| Seeds | Owner | Purpose |
|---|---|---|
| `["mint_owner", mint]` | `deploy` | Stores deployer + bump; type `common::state::MintOwner` |
| `["temp_mint_authority", mint]` | `deploy` | Ephemeral signing key during `deploy_mint` only |
| `["mint_authority", mint]` | `mint` | Token-2022 mint authority |
| `["metadata_update_authority", mint]` | `metadata-update` | Token-2022 metadata update authority |
| `["frozen_account", mint, account]` | `freeze` | Marker: account fully frozen |
| `["frozen_balance", mint, account]` | `freeze` | Stores locked balance for partial freeze |
| `["permanent_delegate", mint]` | `operations` | Token-2022 PermanentDelegate authority |
| `["permissioned_burn", mint]` | `operations` | Token-2022 PermissionedBurn authority; co-signs every burn alongside `permanent_delegate` |
| `["pausable_authority", mint]` | `pause` | Token-2022 Pausable authority |
| `["deactivate", mint]` | `deactivate` | Marker: mint permanently deactivated |
| `["transfer_control_mode", mint]` | `transfer-control` | Stores `is_clearing` flag |
| `["whitelist", mint, account]` | `transfer-control` | Marker: account is whitelisted |
| `["transfer_hook_authority", mint]` | `transfer-hook` | Token-2022 TransferHook extension authority (set on the mint by `deploy_mint`); not passed to `execute` and never used as a signer |
| `["extra-account-metas", mint]` | `transfer-hook` | SPL ExtraAccountMetaList for the hook |
| `["snapshot_counter", mint]` | `snapshot` | Current snapshot index for the mint (created by `take_snapshot`) |
| `["snapshot_totalsupply", mint]` | `snapshot` | `SnapshotHistory` of total supply (one entry per snapshot id) |
| `["snapshot_holderbalance", mint, token_account]` | `snapshot` | `SnapshotHistory` of that holder's balance |
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
| `[mint, account]` | `access-control` | Per-`(mint, account)` `Roles` PDA — **zero-copy** `[u8; ROLES_BYTES_MASK]` role bit-mask; set by `grant_roles`, cleared by `revoke_roles` (no string prefix — raw `mint` + `account` pubkeys). Also read at `[mint, authority]` as the admin-check account by `require_role` |

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
| `PermissionedBurn` | `["permissioned_burn", mint]` | `operations` | Burning requires this authority as an extra signer, so the plain Token-2022 `Burn` is rejected and `operations::burn` / `batch_burn` are the only burn path |
| `TokenMetadata` | `["metadata_update_authority", mint]` | `metadata-update` | Embedded name/symbol/URI + custom fields |
| `TransferHook` | `["transfer_hook_authority", mint]` | `transfer-hook` | Invokes `transfer-hook::execute` on every `transfer_checked`. The hook holds the full compliance suite (deactivation, transfer-mode, whitelist, frozen account, post-debit partial-freeze cover) plus the `TRANSFER_HOOK_EXECUTE` functionality check, and writes nothing. It does not introspect the transaction, so every transfer path is gated identically — the one exemption is the `permanent_delegate` authority, which skips every check so `operations::controller_transfer` can seize tokens. |

---

## Checklist: Adding a New Program

1. Create `programs/<name>/` with the standard structure.
2. Add `common` as a dependency in `Cargo.toml` — program IDs come from `common::program_ids` via `pub use common::program_ids::*;` in `lib.rs`.
3. Add to `Anchor.toml` `[workspace]` members and `[programs.localnet]`.
4. Implement instructions following the correct category pattern above.
5. If the program owns a Token-2022 extension authority PDA: wire it into `deploy` (add crate dep with `cpi` feature, add authority PDA to `DeployMint` accounts, call the extension initializer CPI).
6. Add `tests/<name>.ts` with a `deployMint()` helper.
7. Create `docs/<name>.md` and link it below.

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

---

## License

Released under the [Apache License 2.0](LICENSE).
