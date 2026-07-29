---
name: add-new-instruction
description: Use when adding a new instruction to an existing program in the asseto-solana-programs workspace (e.g. "add a new instruction to X", "implement Y on Z", "add a freeze_something handler"). Covers file layout, lib.rs/mod.rs registration, category-based auth, precondition idioms, account-struct conventions, CPI signing, snapshot integration when tokens move, errors, tests, and docs. Not for creating a new program (use the `add-new-program` skill instead).
---

# Adding a New Instruction

## Start by reading a sibling

Before writing anything, read an existing instruction in the same program to match its style. That file shows the exact patterns for `CHECK:` docs, seeds, CPI signing, and error handling — this skill documents *why* those patterns exist; the sibling shows them in practice.

## 1. File layout

One file per handler under `programs/<x>/src/instructions/<name>.rs`. The file contains **both** the handler fn and its `#[derive(Accounts)]` struct — keeping them together is the convention.

```rust
use anchor_lang::prelude::*;
use common::{require_active, require_functionality, require_not_paused, require_role, roles};
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};

pub fn <name>(ctx: Context<MyAccounts>, /* args */) -> Result<()> {
    // preconditions (see §4)
    // CPIs / core logic
    Ok(())
}

#[derive(Accounts)]
pub struct MyAccounts<'info> {
    // fields (see §5)
}
```

## 2. Register

Two lines in `src/instructions/mod.rs`:

```rust
pub mod <name>;
pub use <name>::*;
```

One dispatch block in `src/lib.rs` inside `#[program] pub mod <x>`:

```rust
pub fn <name>(ctx: Context<MyAccounts>, /* args */) -> Result<()> {
    instructions::<name>::<name>(ctx, /* args */)
}
```

## 3. Pick the category

See the **Instruction Categories** table in `CLAUDE.md`. The category drives your auth pattern:

| Category | Authorisation |
|---|---|
| **Management** | Role-gated. Start the handler with `require_role(ctx.accounts.authority_roles_pda.load()?, roles::ROLE_X)?`. Usually followed by `require_not_paused(&mint)?`, `require_active(&deactivate_pda)?`, and `require_functionality(ctx.accounts.asset_class_version_pda.load()?, common::functionalities::X)?`. If no role fits, check `common::roles` before adding a new one — roles are a flat, append-only `u16` list shared across the whole workspace. |
| **Operational** | Caller is a token holder. Use program-specific gates (ownership, whitelist, etc.). |
| **Auxiliary** | Only callable via CPI from another program. Take a `calling_authority: Signer<'info>` and at runtime `require!(calling_authority.key() == <expected PDA>, ...)`. The expected PDA is derived from seeds owned by the authorised program (see `freeze` for the canonical 3-caller example). |

## 4. Preconditions idiom (Management instructions)

Order matters, and it's consistent across the workspace:

```rust
require_role(ctx.accounts.authority_roles_pda.load()?, roles::ROLE_X)?;
require_not_paused(&ctx.accounts.mint.to_account_info())?;   // if the mint must not be paused
require_active(&ctx.accounts.deactivate_pda.to_account_info())?;
require_functionality(
    ctx.accounts.asset_class_version_pda.load()?,
    common::functionalities::X,
)?;
```

Skip `require_not_paused` if the instruction should remain callable while paused. Skip `require_active` only for instructions *about* deactivation itself. `require_functionality` needs a new `common::functionalities` constant — append it at the end of the file (never reorder/remove existing ones; a unit test enforces sequential-from-zero) and wire it into the mint's asset-class version via `factory`'s `enable_asset_class_version_functionalities` in tests.

This requires three supporting accounts in the struct: `authority_roles_pda` (the caller's own `Roles` PDA, `AccountLoader<Roles>`, seeds `["roles", mint, authority]` owned by `access-control`), `asset_configuration_pda` (`Account<AssetConfiguration>`, seeds `["asset_configuration", mint]` owned by `deploy`, supplies the asset-class ids), and `asset_class_version_pda` (`AccountLoader<AssetClassVersion>`, seeds `["asset_class_version", config_id, version_id]` owned by `factory`, derived from the ids on `asset_configuration_pda`). Copy these three verbatim from any existing Management instruction (e.g. `transfer-control::add_to_whitelist`) — the seeds/bump wiring is boilerplate.

## 5. Account-struct conventions

- Every `UncheckedAccount` needs a `/// CHECK:` comment explaining *how* it's validated (seeds constraint, runtime check, Token-2022 CPI, etc.) — this is the one place a doc comment on a field is expected. Don't add doc comments elsewhere in the struct (field name, seeds, and type already say what the account is; see §9).
- Reference PDAs owned by **other** programs with `seeds::program = constants::X_PROGRAM_ID` — don't omit it.
- Reference PDAs owned by **this** program with just `seeds = [...]`.
- Use `Account<'info, T>` for accounts your program owns and deserialises; use `UncheckedAccount<'info>` when the account is owned by another program (Anchor's `Account<T>` enforces ownership-by-current-program, which will fail).
- Pin program-id accounts with `#[account(address = constants::X_PROGRAM_ID)]` on an `UncheckedAccount`.
- Use `#[account(mut)]` only when you actually modify; Anchor enforces this at runtime.
- For PDA-signed CPIs, declare the authority PDA in the struct with its seeds, grab `ctx.bumps.<authority>` in the handler, and build `&[&[b"seed", mint.as_ref(), &[bump]]]` for `CpiContext::new_with_signer`.

## 6. CPI signing pattern

The canonical form when the caller is one of this program's PDAs:

```rust
let mint_key = ctx.accounts.mint.key();
let authority_seeds: &[&[u8]] = &[b"<seed>", mint_key.as_ref(), &[ctx.bumps.<authority>]];

snapshot::cpi::take_snapshot(
    CpiContext::new_with_signer(
        constants::SNAPSHOT_PROGRAM_ID,
        TakeSnapshot { /* field = to_account_info() per struct field */ },
        &[authority_seeds],
    ),
    merkle_root,
)?;
```

See [`coupon::create_coupon`](../../../programs/coupon/src/instructions/create_coupon.rs) for the full worked version.

If the target crate exposes `cpi::accounts::*`, import those. Avoid hand-rolling `invoke_signed` unless the target is Token-2022 or System directly.

When the target is Token-2022 and the mint needs more than one signing authority, pass every seed set in one `invoke_signed` — e.g. `operations::burn` signs with both the permanent-delegate and permissioned-burn PDAs, since the `PermissionedBurn` extension requires both. Adding an extra `AccountInfo` to the infos array is *not* enough: an account the instruction's own `AccountMeta` list doesn't reference is never passed to the callee.

## 7. Errors

Add new variants to the program's `errors.rs` when needed:

```rust
#[error_code]
pub enum ErrorCode {
    #[msg("Human-readable message")]
    MyNewError,
}
```

Raise via `require!(cond, ErrorCode::MyNewError)` or `return err!(ErrorCode::MyNewError)`.

## 8. Docs

Update `docs/<x>.md` with a new section for the instruction, in this order: a **lead sentence or two describing what the instruction does in plain language** (not just "No parameters." or a jump straight to the table — every instruction needs this even if trivial), then params, account table (one row per field with notes), and execution steps. If you added a new PDA or changed auth semantics, also update the relevant tables in `CLAUDE.md`.

`docs/<x>.md` is the source of truth for *what* an instruction does and *why* its accounts/preconditions are shaped the way they are — this drives §9 below.

## 9. Code comments: why, not what

Once the docs above are written, the handler and `#[derive(Accounts)]` struct should carry almost no comments. Specifically:

- **No function-level doc comment restating what the docs already say.** If `docs/<x>.md` describes the instruction, a `///` comment above `pub fn <name>` that says the same thing in Rust prose is pure duplication — delete it.
- **No field-level doc comments that restate the field name/type/seeds** (e.g. `/// The Token-2022 mint.` above `pub mint: UncheckedAccount<'info>`, or `/// Deactivation marker PDA — must not exist...` above a `deactivate_pda` field whose seeds and `require_active` call already say that). The `/// CHECK:` comment (§5) is the only doc comment expected on most fields.
- **Do** keep a comment when it encodes something the compiler won't catch and the docs don't already state as clearly in-line at the point of use — e.g. a load-bearing account-ordering invariant (the transfer hook reads `source` / `destination` / `mint` from `transfer::verify_transfer` at fixed indices, so they may not be reordered), a non-obvious arithmetic or padding rationale, or a workaround for a specific runtime constraint (BPF stack limits, heap limits).
- Section-marker comments like `// ── Auth + state checks ──` inside a handler body are fine to keep or drop at your judgement — they're navigational, not explanatory duplication.
- If you're ever unsure whether a comment is "why" (keep) or "what" (cut), ask: does removing it lose information not already in `docs/<x>.md` or obvious from the code itself? If no, cut it.
