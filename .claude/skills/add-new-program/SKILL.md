---
name: add-new-program
description: Use when creating a new program in the asseto-solana-programs Anchor workspace (e.g. "add a new X program", "create a program for Y", "scaffold a new compliance extension"). Covers crate scaffolding, Anchor.toml registration, constants and circular-dependency handling, instruction category, CPI wiring into deploy when a Token-2022 authority PDA is introduced, tests, and docs.
---

# Adding a New Program

Follow these steps in order when adding a new program to `programs/`. Cross-reference the PDA seed table, circular-dependency map, and instruction-category table in `CLAUDE.md` as you go.

## 1. Create the crate

```
programs/<name>/
├── Cargo.toml
└── src/
    ├── lib.rs           — declare_id!, mod declarations, #[program] impl
    ├── constants.rs     — program IDs used in account constraints
    ├── errors.rs        — #[error_code] enum (if needed)
    ├── state.rs / state/ — on-chain account structs (if needed)
    └── instructions/
        ├── mod.rs
        └── <instruction>.rs   — one handler per file
```

`Cargo.toml` should mirror an existing sibling (e.g. `pause/Cargo.toml`): `anchor-lang` with `interface-instructions` (+ `init-if-needed` if you use it), `anchor-spl`, `spl-token-2022` with `no-entrypoint`, and `common` for shared helpers.

Pick a unique program ID via `solana-keygen new -o target/deploy/<name>-keypair.json` and put it in `declare_id!` in `lib.rs`.

## 2. Wire constants

In `constants.rs`, import program IDs you'll reference:

```rust
pub use deploy::ID as DEPLOY_PROGRAM_ID;
```

If the natural import would create a cycle (see the **Circular dependency map** in `CLAUDE.md`), hardcode with `Pubkey::new_from_array([...])` and leave a comment explaining why. Keep hardcoded IDs in sync with the corresponding `declare_id!` manually.

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

- **Management** — caller is the deployer. Gate with `common::verify_deployer` + optionally `require_not_paused` / `require_active`.
- **Operational** — caller is a token holder / participant. Gate with program-specific access rules (ownership checks, whitelist, etc.).
- **Auxiliary** — callable only via CPI from another program. Declare `calling_authority: Signer` and check at runtime that its pubkey equals a known PDA (`mint_authority` / `permanent_delegate` / `transfer_hook_authority` / …). No external wallet can produce those signatures.

## 5. If the program owns a Token-2022 extension authority PDA

Wire it into `deploy`:

1. Add a dep on your crate with `features = ["cpi"]` in `deploy/Cargo.toml`.
2. Export the program ID from `deploy/src/constants.rs` (`pub use <name>::ID as …`).
3. Add the authority PDA to `DeployMint` accounts (seeds-constrained).
4. Add the initializer CPI call to the relevant step of `deploy_mint` so the Token-2022 extension is configured with your PDA as authority during deployment.
5. Update the **Token-2022 Extensions** and **PDA Seed Reference** tables in `CLAUDE.md`.

## 6. Tests

Add `tests/<name>.ts`. Copy the `deployMint()` helper from a sibling test (it's near-identical across files) and reuse it — tests need a fresh mint per case.

## 7. Docs

1. Create `docs/<name>.md` following the same layout as other program docs: state, error codes, per-instruction sections (params + accounts table + execution steps), constants.
2. Add a bullet to the **Detailed Program References** list in `CLAUDE.md`.
3. Add the program to the programs table in `README.md`.
4. Add the program's PDAs to **PDA Seed Reference** in `CLAUDE.md`.
5. Add the program ID to the **Program IDs** table in `CLAUDE.md`.
