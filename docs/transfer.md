# transfer — Program Reference

Program ID: `Fa5VLqopKp6cokXJreYeNNmUG8F9AaE4CUBnGQvtdq7Q`

Hosts the one transfer topology Token-2022 cannot express on its own: `batch_transfer`,
one source holder fanning tokens out to many destinations in a single instruction.
Nothing else lives here. There is no wrapper for the singular transfer and no
compliance pre-check instruction — a holder submits Token-2022's own
`transfer_checked`, and **every compliance rule runs inside
`transfer-hook::execute`**, which Token-2022 invokes from within that
`transfer_checked` (deactivation, transfer-mode / whitelist, frozen account,
frozen balance, plus the `TRANSFER_HOOK_EXECUTE` functionality gate). See
[`transfer-hook.md`](transfer-hook.md) for the rules themselves.

Consequences of that shape:

- No mandatory transaction layout. A transfer is a single instruction, so any
  program may compose on it — the hook fires from the CPI either way.
- This program owns no PDA and signs nothing. Even `batch_transfer`'s legs are
  authorised by the `source_owner` signature the client already provides.
- The program itself performs no compliance checks. Its only validation is
  structural (`amounts` non-empty, `remaining_accounts` count), and it forwards
  the hook's accounts to each leg.

Earlier revisions used a `verify_transfer` pre-instruction plus instruction
introspection in the hook, to keep the hook's `ExtraAccountMetaList` small enough
for Token-2022's 32 KiB heap. That design is gone; the heap constraint is not, and
it still caps how many accounts the hook may declare — see
[`transfer-hook.md`](transfer-hook.md#metalist-contents).

---

## Required client flow

Singular transfer — a single top-level instruction:

```
N:  Token-2022::transfer_checked(amount)   // hook accounts appended
```

Batch transfer — likewise a single instruction:

```
N:  transfer::batch_transfer(amounts)
```

Both need a raised compute budget: resolving the metalist and running the hook
does not fit the 200 K CU a one-instruction transaction is given by default. The
test helpers prepend `ComputeBudgetProgram.setComputeUnitLimit` (400 K for the
singular path, scaled by destination count for the batch). `requestHeapFrame` is
pointless here — Token-2022's allocator ignores it (see
[`transfer-hook.md`](transfer-hook.md#metalist-contents)).

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
| 9 | `asset_class_version_pda` | no | no | The hook's functionality gate reads it |
| 10 | `deactivate_program` | no | no | `DEACTIVATE_PROGRAM_ID` |
| 11 | `deactivate_pda` | no | no | seeds `["deactivate", mint]`; must be empty (mint not deactivated) |
| 12 | `transfer_control_program` | no | no | `TRANSFER_CONTROL_PROGRAM_ID` |
| 13 | `transfer_control_mode_pda` | no | no | seeds `["transfer_control_mode", mint]`; may be empty (no mode active) |
| 14 | `source_whitelist_pda` | no | no | seeds `["whitelist", mint, source]`; must exist in whitelist mode |
| 15 | `destination_whitelist_pda` | no | no | seeds `["whitelist", mint, destination]`; must exist in whitelist mode |
| 16 | `freeze_program` | no | no | `FREEZE_PROGRAM_ID` |
| 17 | `source_frozen_pda` | no | no | seeds `["frozen_account", mint, source]`; must be empty |
| 18 | `source_frozen_balance_pda` | no | no | seeds `["frozen_balance", mint, source]`; may be empty (no partial freeze) |
| 19 | `hold_program` | no | no | `HOLD_PROGRAM_ID` |
| 20 | `source_hold_position_pda` | no | no | seeds `["hold_position", mint, source]`; may be empty (no hold ever created on the source) |

**Indices 4–20 are load-bearing in exactly this order** — 4 and 5 are the metalist
PDA and hook program, and 6–20 are the metalist's own entries in declaration
order. Token-2022 re-derives the seed-based entries and checks the forwarded
accounts against them, so a wrong order (or a missing account) fails inside
Token-2022 before the hook runs. Omitting the block entirely does not skip
compliance: the transfer is rejected, because Token-2022 cannot build the hook
CPI.

Nothing here needs a `transfer_authority`, `freeze_authority`,
`transfer_hook_authority`, `snapshot_program` or `system_program`: no program
signs on this path, and the hook writes nothing (balances are committed to a
per-snapshot Merkle root instead), so it creates no accounts and needs no payer.

The test suite's `splTransfer` helper in
[`tests/program_helpers/transfer_helper.ts`](../tests/program_helpers/transfer_helper.ts)
builds this instruction and is the reference implementation. `@solana/spl-token`'s
`createTransferCheckedWithTransferHookInstruction` can also resolve the metalist
automatically instead of appending indices 4–18 by hand.

---

## Instruction: `batch_transfer` (Operational)

One source holder fans tokens out to many destinations, one `transfer_checked`
CPI per destination. Each leg fires the hook with that leg's destination, so
every leg is gated independently and any failing leg reverts the whole
transaction.

### Parameters

```rust
amounts: Vec<u64>  // raw token units per destination, in remaining-accounts order
```

### Accounts

The named accounts are the constant part of the hook block; the per-leg
`(destination, destination_whitelist_pda)` pairs are appended as
`remaining_accounts` (`remaining_accounts.len() == amounts.len() * 2`). The
destination whitelist PDA has to travel per leg because the metalist derives it
from the destination token account.

| Idx | Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|---|
| 0 | `source_owner` | no | yes | Signer | Token-2022 enforces `source.owner == source_owner` natively on every leg |
| 1 | `source` | yes | no | UncheckedAccount | Shared source token account |
| 2 | `mint` | no | no | UncheckedAccount | Token-2022 mint; decimals read once, before the loop |
| 3 | `extra_account_meta_list` | no | no | UncheckedAccount | seeds `["extra-account-metas", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID` |
| 4 | `transfer_hook_program` | no | no | UncheckedAccount | address = `TRANSFER_HOOK_PROGRAM_ID` |
| 5 | `freeze_program` | no | no | UncheckedAccount | address = `FREEZE_PROGRAM_ID` |
| 6 | `deploy_program` | no | no | UncheckedAccount | address = `DEPLOY_PROGRAM_ID` |
| 7 | `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| 8 | `factory_program` | no | no | UncheckedAccount | address = `FACTORY_PROGRAM_ID` |
| 9 | `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID` |
| 10 | `deactivate_program` | no | no | UncheckedAccount | address = `DEACTIVATE_PROGRAM_ID` |
| 11 | `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| 12 | `transfer_control_program` | no | no | UncheckedAccount | address = `TRANSFER_CONTROL_PROGRAM_ID` |
| 13 | `transfer_control_mode_pda` | no | no | UncheckedAccount | seeds `["transfer_control_mode", mint]`; may be empty |
| 14 | `source_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, source]`; constant across legs |
| 15 | `source_frozen_pda` | no | no | UncheckedAccount | seeds `["frozen_account", mint, source]` |
| 16 | `source_frozen_balance_pda` | no | no | UncheckedAccount | seeds `["frozen_balance", mint, source]` |
| 17 | `hold_program` | no | no | UncheckedAccount | address = `HOLD_PROGRAM_ID` |
| 18 | `source_hold_position_pda` | no | no | UncheckedAccount | seeds `["hold_position", mint, source]`; may be empty |
| 19 | `token_2022_program` | no | no | Program\<Token2022\> | |
| 20.. | `remaining_accounts` | — | no | — | per leg `i`: `destination_i` (writable) then its `destination_whitelist_pda` |

The declaration order above is *not* the order the accounts are forwarded in —
`freeze_program` sits at index 5 in the struct but is forwarded thirteenth, where
the metalist expects it. The forwarding order is defined once, by the field order
of `common::HookAccounts` (see [`common.md`](common.md#module-hook_accounts)),
which this instruction fills in per leg with **this leg's**
`destination_whitelist_pda` and the same constant entries for the rest. That
order matches the metalist declaration in
[`transfer-hook.md`](transfer-hook.md#metalist-contents).

### Execution

1. `require!(!amounts.is_empty())` → `EmptyBatch`;
   `require!(remaining_accounts.len() == amounts.len() * 2)` → `InvalidRemainingAccounts`.
2. Read `decimals` from `mint` — once, before the loop.
3. For each leg `i`: `invoke` → `transfer_checked(source, mint, destination_i,
   source_owner, amounts[i], decimals)`, with the constant hook block plus leg
   `i`'s `destination_whitelist_pda` appended. Token-2022 fires the hook for that
   leg, which runs the full compliance suite.

`batch_transfer` emits no event.

### How the partial-freeze lock holds across legs

The old `batch_verify_transfer` checked the *sum* of the legs against the source's
unfrozen balance up front. That check is no longer needed: the hook runs
post-debit and asserts `source_balance >= frozen_balance` on **every** leg, so the
cumulative movement can never dip the source below its locked amount — the leg
that would cross the line is the leg that fails. See `require_frozen_balance_covered`
in [`freeze.md`](freeze.md#require_frozen_balance_covered).

### Why this one is still a program instruction

The batch cannot be replaced by calling Token-2022 directly: that would mean N
separate top-level `transfer_checked` instructions, each carrying its own copy of
the hook block — far more transaction bytes for the same movement.

---

## Error Codes

```rust
pub enum TransferError {
    EmptyBatch,                 // amounts is empty
    InvalidRemainingAccounts,   // remaining_accounts.len() != amounts.len() * 2
    BatchAmountOverflow,        // no longer raised — the summed check it guarded lived in batch_verify_transfer
}
```

Compliance errors come from the hook and propagate from its helpers
(`Deactivated`, `NotWhitelisted`, `AccountFrozen`, `InsufficientUnfrozenBalance`,
`FunctionalityNotSupportedError`); see [`transfer-hook.md`](transfer-hook.md).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;`.
