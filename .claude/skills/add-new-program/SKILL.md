---
name: add-new-program
description: Use when creating a new program in the asseto-solana-programs Anchor workspace (e.g. "add a new X program", "create a program for Y", "scaffold a new compliance extension"). Covers crate scaffolding, Anchor.toml registration, wiring the program ID into common::program_ids, instruction category, CPI wiring into deploy when a Token-2022 authority PDA is introduced, tests, and docs.
---

# Adding a New Program

Follow these steps in order when adding a new program to `programs/`. Cross-reference the PDA seed table and instruction-category table in `CLAUDE.md` as you go.

## 1. Create the crate

```
programs/<name>/
├── Cargo.toml
└── src/
    ├── lib.rs           — declare_id!, mod declarations, pub use common::program_ids::*, #[program] impl
    ├── errors.rs        — #[error_code] enum (if needed)
    ├── state.rs / state/ — on-chain account structs (if needed)
    └── instructions/
        ├── mod.rs
        └── <instruction>.rs   — one handler per file
```

There is no per-program `constants.rs` (the sole exception is `transfer-hook`, which keeps one for instruction *discriminators*, not program IDs — see `docs/transfer-hook.md`).

`Cargo.toml` should mirror an existing sibling (e.g. `pause/Cargo.toml` for a simple program, `transfer-control/Cargo.toml` if you need `init_if_needed`): `anchor-lang` with `event-cpi` (+ `init-if-needed` if any instruction uses that constraint), `anchor-spl`, `spl-token-2022` with `no-entrypoint`, and `common` for shared helpers.

Pick a unique program ID via `solana-keygen new -o target/deploy/<name>-keypair.json` and put it in `declare_id!` in `lib.rs`.

## 2. Wire the program ID

All program IDs live in one place, `common/src/program_ids.rs`, as `pubkey!()` constants (`<NAME>_PROGRAM_ID`). Add yours there — no per-program hardcoding, no circular-dependency workaround needed, since `common` has no dependency on any program in the workspace.

Re-export it at your crate root in `lib.rs`:

```rust
pub use common::program_ids::*;
```

Instructions then reference any program's ID (including your own, if needed) via:

```rust
use common::program_ids as constants;
// …
seeds::program = constants::<NAME>_PROGRAM_ID,
```

**When you change a program ID later:** it's a literal in three places — update all of them: `declare_id!` in the program's own `lib.rs`, the workspace `Anchor.toml`, and the constant in `common/src/program_ids.rs`.

## 3. Register with Anchor

Edit `Anchor.toml`:

```toml
[workspace]
members = [
    # …
    "programs/<name>",
]

[programs.localnet]
<name> = "<new-program-id>"
```

The workspace `Cargo.toml` picks programs up via the `programs/*` glob, so nothing needed there.

## 4. Decide the instruction category

Every instruction belongs to one of the three categories in `CLAUDE.md`'s **Instruction Categories** table. Use the matching authorization pattern:

- **Management** — caller is any authority holding the relevant role. Gate with `common::require_role(authority_roles_pda.load()?, roles::ROLE_X)` + optionally `require_not_paused` / `require_active` / `require_functionality`. If an existing role fits, reuse it (`common::roles`); otherwise append a new `ROLE_*` constant at the end of that file (never reorder/remove — a unit test enforces sequential-from-zero). See the `add-new-instruction` skill for the exact precondition idiom and the three supporting accounts (`authority_roles_pda`, `asset_configuration_pda`, `asset_class_version_pda`) this requires.
- **Operational** — caller is a token holder / participant. Gate with program-specific access rules (ownership checks, whitelist, etc.).
- **Auxiliary** — callable only via CPI from another program. Declare `calling_authority: Signer` and check at runtime that its pubkey equals a known PDA (`mint_authority` / `permanent_delegate` / `transfer_hook_authority` / …). No external wallet can produce those signatures.

## 5. If the program owns a Token-2022 extension authority PDA

Wire it into `deploy`:

1. Add a dep on your crate with `features = ["cpi"]` in `deploy/Cargo.toml` (see the existing `freeze`, `mint`, `pause`, etc. deps there for the pattern).
2. Your program ID is already available via `common::program_ids::<NAME>_PROGRAM_ID` (step 2 above) — no separate export needed in `deploy`.
3. Add the authority PDA to `DeployMint` accounts (seeds-constrained).
4. Add the initializer CPI call to the relevant step of `deploy_mint` so the Token-2022 extension is configured with your PDA as authority during deployment.
5. Update the **Token-2022 Extensions** and **PDA Seed Reference** tables in `CLAUDE.md`.

## 6. Tests

Add `tests/<name>.ts`. Copy the `deployMint()` helper from a sibling test (it's near-identical across files) and reuse it — tests need a fresh mint per case.

## 7. Docs

1. Create `docs/<name>.md` following the same layout as other program docs: state, error codes, per-instruction sections (a plain-language lead sentence describing what the instruction does, then params, accounts table, execution steps — see the `add-new-instruction` skill §8-9 for the doc-vs-code-comment split this project follows), constants.
2. Add a bullet to the **Detailed Program References** list in `CLAUDE.md`.
3. Add the program ID to the **Program IDs** table in `CLAUDE.md` and the equivalent table in `README.md`.
4. Add the program's PDAs to **PDA Seed Reference** in `CLAUDE.md`.
5. Add the program's crate description to the `Code Structure` tree in `CLAUDE.md`.
5. Add the program ID to the **Program IDs** table in `CLAUDE.md`.
