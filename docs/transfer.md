# transfer — Program Reference

Program ID: `Fa5VLqopKp6cokXJreYeNNmUG8F9AaE4CUBnGQvtdq7Q`

The compliance gate for transfers. This program does not move tokens: holders
submit `verify_transfer` (compliance pre-check) followed immediately by
Token-2022's own `transfer_checked`, which performs the movement. Token-2022
invokes `transfer-hook::execute` from inside that `transfer_checked`; the hook
reads the `Instructions` sysvar and
**rejects the transfer unless `verify_transfer` was the immediately-prior
top-level instruction** with matching `source` / `destination` / `mint` /
`amount`. That double-introspection check is what lets us keep all
compliance logic in `verify_transfer` (cheap, runs against pre-debit state) and
keep the hook tiny so its `ExtraAccountMetaList` resolution fits in
Token-2022's hard-coded 32 KiB heap. See
[`docs/transfer-hook-heap-oom.md`](transfer-hook-heap-oom.md) for the
background on that constraint.

This program owns no PDA, signs nothing, and issues no CPI on the singular path —
`transfer_checked` is a top-level instruction authorised by the `source_owner`
signature the client already provides. Freezing is enforced read-side, by
`verify_transfer` reading `freeze`'s marker PDAs. The only instruction here that
moves tokens is `batch_transfer`, which exists to fan one source out to many
destinations in a single instruction (see [below](#instruction-batch_transfer-operational)).

---

## Required client flow

Every transfer **must** be submitted as two adjacent top-level instructions in
the same transaction, in this order:

```
N-1:  transfer::verify_transfer(amount)
N:    Token-2022::transfer_checked(amount)
```

A `transfer_checked` without a matching `verify_transfer` at N-1 is rejected by
the hook with one of the `Prev*` / `Current*` introspection errors. ComputeBudget
instructions and other unrelated pre-instructions are fine **as long as
`verify_transfer` remains at index N-1**; in particular, place ComputeBudget
*before* `verify_transfer`, not between it and the `transfer_checked`.

The `transfer_checked` must carry the hook's accounts appended after its own four
— see [Building the `transfer_checked` instruction](#building-the-transfer_checked-instruction).

The **batch** variant follows the same two-instruction shape, one source
holder fanning out to many destinations:

```
N-1:  transfer::batch_verify_transfer(amounts)
N:    transfer::batch_transfer(amounts)
```

`batch_transfer` fires the hook once per leg; each firing introspects this
pair and requires the hooked `(source, destination, amount)` to appear in
both instructions (see [`transfer-hook.md`](transfer-hook.md)). The two batch
instructions must carry the **same `amounts` vector**, `batch_verify_transfer`
must sit at `N-1`, and `batch_transfer` at `N`.

---

## Instruction: `verify_transfer` (Operational)

Pre-transfer compliance gate. Runs the full rule set against the
*pre-debit* state of the source account, without moving any tokens. Designed
to be the immediately-prior top-level instruction before the `transfer_checked`
in a transaction; the hook introspects this call and demands the
`source` / `destination` / `mint` / `amount` match.

### Parameters

```rust
amount: u64  // must equal the amount passed to the following `transfer_checked`
```

### Accounts

**Account ordering is part of this instruction's contract** — the hook reads
`source`, `destination` and `mint` at indices 1, 2 and 3, so these may not be
reordered.

| Idx | Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|---|
| 0 | `source_owner` | no | yes | Signer | Token holder authorising the transfer |
| 1 | `source` | no | no | UncheckedAccount | Source token account; balance read for `require_unfrozen_balance` |
| 2 | `destination` | no | no | UncheckedAccount | Used as a seed for `destination_whitelist_pda` |
| 3 | `mint` | no | no | UncheckedAccount | Token-2022 mint |
| 4 | `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| 5 | `transfer_control_mode_pda` | no | no | UncheckedAccount | seeds `["transfer_control_mode", mint]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; may be empty (no mode active) |
| 6 | `source_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, source]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; must exist in whitelist mode |
| 7 | `destination_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, destination]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; must exist in whitelist mode |
| 8 | `source_frozen_pda` | no | no | UncheckedAccount | seeds `["frozen_account", mint, source]`, `seeds::program = FREEZE_PROGRAM_ID` |
| 9 | `source_frozen_balance_pda` | no | no | UncheckedAccount | seeds `["frozen_balance", mint, source]`, `seeds::program = FREEZE_PROGRAM_ID` |

### Execution

1. `require_active(&deactivate_pda)` — mint must not be deactivated.
2. `transfer_control::verify_transfer_control_mode(&transfer_control_mode_pda, &[&source_whitelist_pda, &destination_whitelist_pda])`
   — a no-op if `transfer_control_mode_pda` is empty (no mode active); otherwise, in whitelist
   mode, both the source and destination whitelist PDAs are checked.
3. `require_unfrozen_account(&source_frozen_pda)` — source must not be fully frozen.
4. `require_unfrozen_balance(amount, &source, &source_frozen_balance_pda)`
   — pre-debit available balance covers `amount`.

No token movement, no CPIs, no state changes. Pure read-only check.

Source ownership is **not** checked here — Token-2022 enforces it natively
during `transfer_checked` in the next instruction, so a separate check would
be redundant and require holding `source_owner` with the `mut` flag this
instruction doesn't need.

---

## Building the `transfer_checked` instruction

There is no wrapper instruction for the singular transfer — the client builds
Token-2022's `transfer_checked` itself. `transfer_checked` produces only 4
`AccountMeta` entries, and Token-2022 uses `instruction.accounts` to discover
which accounts are reachable during the hook invocation, so the hook's accounts
must be **appended** to that list.

| Idx | Account | Mut | Signer | Notes |
|---|---|---|---|---|
| 0 | `source` | yes | no | Source token account |
| 1 | `mint` | no | no | Token-2022 mint |
| 2 | `destination` | yes | no | Destination token account |
| 3 | `source_owner` | no | yes | Token-2022 enforces `source.owner == source_owner` natively |
| 4 | `extra_account_meta_list` | no | no | seeds `["extra-account-metas", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID` |
| 5 | `transfer_hook_program` | no | no | `TRANSFER_HOOK_PROGRAM_ID` |
| 6 | `deploy_program` | no | no | `DEPLOY_PROGRAM_ID`; the metalist resolves `asset_configuration_pda` against it |
| 7 | `asset_configuration_pda` | no | no | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; the hook reads the asset-class ids off it |
| 8 | `factory_program` | no | no | `FACTORY_PROGRAM_ID`; the metalist resolves `asset_class_version_pda` against it |
| 9 | `asset_class_version_pda` | no | no | Verified by Token-2022 against the metalist's seed-derived entry; the hook's functionality gate reads it |
| 10 | `instructions_sysvar` | no | no | `Sysvar1nstructions...`; the hook introspects it |

**Indices 4–10 are load-bearing in exactly this order** — indices 4 and 5 are the
metalist PDA and hook program, and 6–10 are the metalist's own entries in
declaration order. Token-2022 resolves the metalist and checks the forwarded
accounts against it, so a wrong order fails inside Token-2022 before the hook
runs.

Note the account order differs from `verify_transfer`'s: `transfer_checked` is
`(source, mint, destination, owner)` whereas `verify_transfer` is
`(source_owner, source, destination, mint)`. The hook knows both layouts and
compares the two instructions field-by-field, so the two orders do **not** need to
agree — but neither may be reordered, since the hook reads each at fixed indices.

Nothing here needs a `transfer_authority`, `freeze_authority`, `freeze_program`,
`transfer_hook_authority`, `snapshot_program`, `snapshot_counter_pda`,
`sender_snapshot`, `receiver_snapshot` or `system_program`: no program signs on
this path, and the hook writes no holder-balance snapshots (balances are committed
to a per-snapshot Merkle root instead), so it creates no accounts and needs no
payer.

The test suite's `splTransfer` helper in
[`tests/program_helpers/transfer_helper.ts`](../tests/program_helpers/transfer_helper.ts)
builds this pair and is the reference implementation. `@solana/spl-token`'s
`createTransferCheckedWithTransferHookInstruction` can also resolve the metalist
automatically instead of appending indices 4–10 by hand.

---

## Instruction: `batch_verify_transfer` (Operational)

Batch counterpart of `verify_transfer` for the "one source holder → many
destinations" topology. Runs the same pre-debit compliance rule set once for
the shared source and once per destination, without moving any tokens. Designed
to be the immediately-prior top-level instruction before `batch_transfer`; the
hook introspects this call and demands the hooked `(source, destination,
amount)` leg appear in it.

### Parameters

```rust
amounts: Vec<u64>  // one entry per destination; must equal the vector passed to the following batch_transfer
```

### Accounts

**Account ordering is part of this instruction's contract** — the hook reads
`source` at index 1 and `mint` at index 2. The per-destination
`(destination, destination_whitelist_pda)` pairs are appended as
`remaining_accounts` (like `mint::batch_mint`).

| Idx | Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|---|
| 0 | `source_owner` | no | yes | Signer | Token holder authorising the batch |
| 1 | `source` | no | no | UncheckedAccount | Shared source token account; balance read for `require_unfrozen_balance` |
| 2 | `mint` | no | no | UncheckedAccount | Token-2022 mint |
| 3 | `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| 4 | `transfer_control_mode_pda` | no | no | UncheckedAccount | seeds `["transfer_control_mode", mint]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; may be empty (no mode active) |
| 5 | `source_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, source]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; must exist in whitelist mode |
| 6 | `source_frozen_pda` | no | no | UncheckedAccount | seeds `["frozen_account", mint, source]`, `seeds::program = FREEZE_PROGRAM_ID` |
| 7 | `source_frozen_balance_pda` | no | no | UncheckedAccount | seeds `["frozen_balance", mint, source]`, `seeds::program = FREEZE_PROGRAM_ID` |

### Remaining accounts

Two accounts per destination, in order (`remaining_accounts.len() == amounts.len() * 2`):

| Offset (per leg `i`) | Account | Notes |
|---|---|---|
| `2i` | destination token account | used as the whitelist-PDA seed and matched by the hook |
| `2i+1` | destination whitelist PDA | seeds `["whitelist", mint, destination]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; canonicity checked via `verify_whitelist_pda`, existence via `verify_whitelist` — only in whitelist mode |

### Execution

1. `require!(!amounts.is_empty())` → `EmptyBatch`; `require!(remaining_accounts.len() == amounts.len() * 2)` → `InvalidRemainingAccounts`.
2. `require_active(&deactivate_pda)`.
3. `require_unfrozen_account(&source_frozen_pda)` — the shared source must not be fully frozen.
4. `require_unfrozen_balance(sum(amounts), &source, &source_frozen_balance_pda)` — the pre-debit available balance covers the **sum** of the batch (`checked_add`; overflow → `BatchAmountOverflow`).
5. In whitelist mode: `source` whitelisted once, then each destination's whitelist PDA verified for canonicity and existence.

No token movement, no CPIs, no state changes.

---

## Instruction: `batch_transfer` (Operational)

Batch counterpart of `transfer`: one source holder fans tokens out to many
destinations in a single instruction, one `transfer_checked` CPI per destination.
Each `transfer_checked` fires the hook, which introspects the
`batch_verify_transfer` (N-1) + `batch_transfer` (N) pair.

### Parameters

```rust
amounts: Vec<u64>  // raw token units per destination; must equal the vector passed to the prior batch_verify_transfer
```

### Accounts

Account ordering at indices 0–2 (`source_owner`, `source`, `mint`) is fixed so
the hook can locate `source`/`mint` and match the destinations. The destination
token accounts are appended as `remaining_accounts`, one per amount
(`remaining_accounts.len() == amounts.len()`), and indices 3–9 are the same hook
accounts, in the same load-bearing order, as the singular path documented above.

| Idx | Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|---|
| 0 | `source_owner` | no | yes | Signer | Token-2022 enforces `source.owner == source_owner` natively |
| 1 | `source` | yes | no | UncheckedAccount | Shared source token account |
| 2 | `mint` | no | no | UncheckedAccount | Token-2022 mint; decimals read for `transfer_checked` |
| 3 | `extra_account_meta_list` | no | no | UncheckedAccount | seeds `["extra-account-metas", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID` |
| 4 | `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID` |
| 5 | `deploy_program` | no | no | UncheckedAccount | forwarded; address constrained to `DEPLOY_PROGRAM_ID` |
| 6 | `asset_configuration_pda` | no | no | UncheckedAccount | forwarded; seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| 7 | `factory_program` | no | no | UncheckedAccount | forwarded; address constrained to `FACTORY_PROGRAM_ID` |
| 8 | `asset_class_version_pda` | no | no | UncheckedAccount | forwarded; verified by Token-2022 against the metalist |
| 9 | `instructions_sysvar` | no | no | UncheckedAccount | address constrained to `Sysvar1nstructions...`; forwarded to the hook |
| 10 | `token_2022_program` | no | no | Program<Token2022> | |
| 11.. | destination token accounts | yes | no | `remaining_accounts` | one per amount, in `amounts` order |

There is no `transfer_authority`, `freeze_authority` or `freeze_program` here —
this instruction signs nothing either; each leg's `transfer_checked` is authorised
by the `source_owner` signature on the transaction.

### Execution

1. `require!(!amounts.is_empty())` → `EmptyBatch`; `require!(remaining_accounts.len() == amounts.len())` → `InvalidRemainingAccounts`.
2. Read `decimals` from `mint` — once, before the loop.
3. For each destination `i`: `invoke` → `transfer_checked(source, mint, destination_i, source_owner, amounts[i], decimals)` with the same 5 metalist entries appended. The hook runs its batch introspection per leg.

`batch_transfer` emits no event.

### Why this one is still a program instruction

Unlike the singular path, the batch cannot be replaced by calling Token-2022
directly. Doing so would mean N separate top-level `transfer_checked`
instructions, each needing its own `verify_transfer` at N-1 — more transaction
bytes, and it would lose the batch-level check of the **sum** of all legs against
the source's unfrozen balance. That sum check is what stops two legs of 100 from
both matching a single verified leg of 100; see the pair-identity discussion in
[`transfer-hook.md`](transfer-hook.md).

---

## Error Codes

```rust
pub enum TransferError {
    EmptyBatch,                 // amounts is empty
    InvalidRemainingAccounts,   // remaining_accounts count doesn't match amounts (×1 for transfer, ×2 for verify)
    BatchAmountOverflow,        // sum of batch amounts overflows u64
}
```

Other errors propagate from the helpers `verify_transfer` calls:
- `common::CommonError::Deactivated`
- `freeze::ErrorCode::{AccountFrozen, InsufficientUnfrozenBalance}`
- `transfer_control::TransferControlError::NotWhitelisted`

The hook itself raises `transfer_hook::TransferHookError::*` on
introspection failure (see [`transfer-hook.md`](transfer-hook.md)).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
