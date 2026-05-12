---
name: add-new-instruction
description: Use when adding a new instruction to an existing program in the cmtat-one-atelier-poc workspace (e.g. "add a new instruction to cmtat-X", "implement Y on cmtat-Z", "add a freeze_something handler"). Covers file layout, lib.rs/mod.rs registration, category-based auth, precondition idioms, account-struct conventions, CPI signing, snapshot integration when tokens move, errors, tests, and docs. Not for creating a new program (use the `add-new-program` skill instead).
---

# Adding a New Instruction

## Start by reading a sibling

Before writing anything, read an existing instruction in the same program to match its style. That file shows the exact patterns for `CHECK:` docs, seeds, CPI signing, and error handling — this skill documents *why* those patterns exist; the sibling shows them in practice.

## 1. File layout

One file per handler under `programs/cmtat-<x>/src/instructions/<name>.rs`. The file contains **both** the handler fn and its `#[derive(Accounts)]` struct — keeping them together is the convention.

```rust
use anchor_lang::prelude::*;
use crate::constants;
use cmtat_common::{verify_deployer, require_active /*, require_not_paused */};

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

One dispatch block in `src/lib.rs` inside `#[program] pub mod cmtat_<x>`:

```rust
pub fn <name>(ctx: Context<MyAccounts>, /* args */) -> Result<()> {
    instructions::<name>::<name>(ctx, /* args */)
}
```

## 3. Pick the category

See the **Instruction Categories** table in `CLAUDE.md`. The category drives your auth pattern:

| Category | Authorisation |
|---|---|
| **Management** | Deployer-gated. Start the handler with `verify_deployer(&mint_owner_pda, &deployer.key())?`. Usually also `require_not_paused(&mint)?` and/or `require_active(&deactivate_pda)?`. |
| **Operational** | Caller is a token holder. Use program-specific gates (ownership, whitelist, etc.). |
| **Auxiliary** | Only callable via CPI from another program. Take a `calling_authority: Signer<'info>` and at runtime `require!(calling_authority.key() == <expected PDA>, ...)`. The expected PDA is derived from seeds owned by the authorised program (see `cmtat-freeze` for the canonical 3-caller example). |

## 4. Preconditions idiom (Management instructions)

Order matters, and it's consistent across the workspace:

```rust
verify_deployer(&ctx.accounts.mint_owner_pda.to_account_info(), &ctx.accounts.deployer.key())?;
require_not_paused(&ctx.accounts.mint.to_account_info())?;   // if the mint must not be paused
require_active(&ctx.accounts.deactivate_pda.to_account_info())?;
```

Skip `require_not_paused` if the instruction should remain callable while paused. Skip `require_active` only for instructions *about* deactivation itself.

## 5. Account-struct conventions

- Every `UncheckedAccount` needs a `/// CHECK:` comment explaining *how* it's validated (seeds constraint, runtime check, Token-2022 CPI, etc.).
- Reference PDAs owned by **other** programs with `seeds::program = constants::CMTAT_X_PROGRAM_ID` — don't omit it.
- Reference PDAs owned by **this** program with just `seeds = [...]`.
- Use `Account<'info, T>` for accounts your program owns and deserialises; use `UncheckedAccount<'info>` when the account is owned by another program (Anchor's `Account<T>` enforces ownership-by-current-program, which will fail).
- Pin program-id accounts with `#[account(address = constants::CMTAT_X_PROGRAM_ID)]` on an `UncheckedAccount`.
- Use `#[account(mut)]` only when you actually modify; Anchor enforces this at runtime.
- For PDA-signed CPIs, declare the authority PDA in the struct with its seeds, grab `ctx.bumps.<authority>` in the handler, and build `&[&[b"seed", mint.as_ref(), &[bump]]]` for `CpiContext::new_with_signer`.

## 6. CPI signing pattern

The canonical form when the caller is one of this program's PDAs:

```rust
let mint_key = ctx.accounts.mint.key();
let authority_seeds: &[&[u8]] = &[b"<seed>", mint_key.as_ref(), &[ctx.bumps.<authority>]];

cmtat_freeze::cpi::block_account(
    CpiContext::new_with_signer(
        ctx.accounts.freeze_program.to_account_info(),
        BlockAccount { /* field = to_account_info() per struct field */ },
        &[authority_seeds],
    ),
)?;
```

If the target crate exposes `cpi::accounts::*`, import those. Avoid hand-rolling `invoke_signed` unless the target is Token-2022 or System directly.

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

Update `docs/cmtat-<x>.md` with a new section for the instruction: params, account table (one row per field with notes), execution steps. If you added a new PDA or changed auth semantics, also update the relevant tables in `CLAUDE.md`.
