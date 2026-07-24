# transfer — Program Reference

Program ID: `Fa5VLqopKp6cokXJreYeNNmUG8F9AaE4CUBnGQvtdq7Q`

The custom transfer endpoint. Token holders interact with this program
in a two-instruction sequence: `verify_transfer` (compliance pre-check) followed
immediately by `transfer` (the actual unblock → `transfer_checked` → re-block
sequence). Token-2022 invokes `transfer-hook::execute` from inside the
inner `transfer_checked` CPI; the hook reads the `Instructions` sysvar and
**rejects the transfer unless `verify_transfer` was the immediately-prior
top-level instruction** with matching `source` / `destination` / `mint` /
`amount`. That double-introspection check is what lets us keep all
compliance logic in `verify_transfer` (cheap, runs against pre-debit state) and
keep the hook tiny so its `ExtraAccountMetaList` resolution fits in
Token-2022's hard-coded 32 KiB heap. See
[`docs/transfer-hook-heap-oom.md`](transfer-hook-heap-oom.md) for the
background on that constraint.

Owns the `["transfer", mint]` PDA, which acts as the signing authority for the
block/unblock CPIs to `freeze` and is one of the three callers accepted
by `freeze`'s auxiliary instructions.

---

## Required client flow

Every transfer **must** be submitted as two adjacent top-level instructions in
the same transaction, in this order:

```
N-1:  transfer::verify_transfer(amount)
N:    transfer::transfer(amount)
```

A bare `transfer::transfer` (or a direct top-level
`Token-2022::transfer_checked`) is rejected by the hook with one of the
`Prev*` / `Current*` introspection errors. ComputeBudget instructions and
other unrelated pre-instructions are fine **as long as `verify_transfer`
remains at index N-1**; in particular, place ComputeBudget *before*
`verify_transfer`, not between it and `transfer`.

---

## Instruction: `verify_transfer` (Operational)

Pre-transfer compliance gate. Runs the full rule set against the
*pre-debit* state of the source account, without moving any tokens. Designed
to be the immediately-prior top-level instruction before `transfer` in a
transaction; the hook introspects this call and demands the
`source` / `destination` / `mint` / `amount` match.

### Parameters

```rust
amount: u64  // must equal the amount passed to the following `transfer`
```

### Accounts

**Account ordering is part of this instruction's contract.** Indices 0–3
(`source_owner`, `source`, `destination`, `mint`) match `transfer` exactly so
the hook can compare both instructions describe the same transfer at fixed
positions.

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

## Instruction: `transfer` (Operational)

The actual token movement. Performs the unblock → `transfer_checked` →
re-block sequence and forwards the hook's `ExtraAccountMetaList` accounts
through the inner `transfer_checked` CPI.

### Parameters

```rust
amount: u64  // raw token units; must equal the amount the prior verify_transfer used
```

### Accounts

Account ordering at indices 0–3 matches `VerifyTransfer` so the hook's
introspection can cross-check both instructions describe the same transfer.

| Idx | Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|---|
| 0 | `source_owner` | no | yes | Signer | Token-2022 enforces `source.owner == source_owner` natively |
| 1 | `source` | yes | no | UncheckedAccount | Source token account |
| 2 | `destination` | yes | no | UncheckedAccount | Destination token account |
| 3 | `mint` | no | no | UncheckedAccount | Token-2022 mint; decimals read for `transfer_checked` |
| 4 | `transfer_authority` | no | no | UncheckedAccount | seeds `["transfer", mint]` (this program); signs block/unblock CPIs |
| 5 | `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]`, `seeds::program = FREEZE_PROGRAM_ID` |
| 6 | `extra_account_meta_list` | no | no | UncheckedAccount | seeds `["extra-account-metas", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID` |
| 7 | `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID` |
| 8 | `freeze_program` | no | no | UncheckedAccount | address constrained to `FREEZE_PROGRAM_ID` |
| 9 | `deploy_program` | no | no | UncheckedAccount | Forwarded; address constrained to `DEPLOY_PROGRAM_ID`. The metalist resolves `asset_configuration_pda` against it |
| 10 | `asset_configuration_pda` | no | no | UncheckedAccount | Forwarded; seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`. The hook reads the asset-class ids off it |
| 11 | `factory_program` | no | no | UncheckedAccount | Forwarded; address constrained to `FACTORY_PROGRAM_ID`. The metalist resolves `asset_class_version_pda` against it |
| 12 | `asset_class_version_pda` | no | no | UncheckedAccount | Forwarded; address verified by Token-2022 against the metalist's seed-derived entry. The hook's functionality gate reads it |
| 13 | `instructions_sysvar` | no | no | UncheckedAccount | address constrained to `Sysvar1nstructions...`; forwarded to the hook for introspection |
| 14 | `token_2022_program` | no | no | Program<Token2022> | |

There is **no** `transfer_hook_authority`, `snapshot_program`,
`snapshot_counter_pda`, `sender_snapshot`, `receiver_snapshot` or
`system_program` here any more: the hook stopped writing holder-balance
snapshots (balances are committed to a per-snapshot Merkle root instead), so
it creates no accounts and needs no payer. Clients using `.accountsStrict()`
must not pass them.

### Execution

1. Read `decimals` from `mint` (required by `transfer_checked`).
2. CPI → `freeze::unblock_account(source)` signed with `["transfer", mint, bump]`.
3. CPI → `freeze::unblock_account(destination)` signed with `["transfer", mint, bump]`.
4. `invoke` → `transfer_checked(source, mint, destination, source_owner, amount, decimals)`.
   The `ExtraAccountMetaList` + `transfer_hook_program` + every account listed
   in the metalist (`deploy_program`, `asset_configuration_pda`,
   `factory_program`, `asset_class_version_pda`, `instructions_sysvar`) are
   appended to `transfer_ix.accounts` (see note below). During this CPI
   Token-2022 invokes `transfer-hook::execute`, which performs the
   double-introspection check and the `TRANSFER_HOOK_EXECUTE` functionality
   check.
5. CPI → `freeze::block_account(source)` signed with `["transfer", mint, bump]`.
6. CPI → `freeze::block_account(destination)` signed with `["transfer", mint, bump]`.

### Transfer hook account list note

`transfer_checked` builds only 4 `AccountMeta` entries. Token-2022 uses
`instruction.accounts` to discover accessible accounts during the hook
invocation, so `extra_account_meta_list`, `transfer_hook_program`, and every
pubkey referenced by the `ExtraAccountMetaList` (the 5 hook extras: deploy
program + `asset_configuration_pda` + factory program +
`asset_class_version_pda` + Instructions sysvar) must be **appended to
`transfer_ix.accounts`** before the `invoke` call.

---

## Error Codes

```rust
pub enum TransferError {
    UnauthorizedTransfer,       // legacy — ownership enforced by Token-2022
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
