# transfer — Program Reference

Program ID: `Fa5VLqopKp6cokXJreYeNNmUG8F9AaE4CUBnGQvtdq7Q`

The custom transfer endpoint. A transfer is a single instruction: `transfer`
performs the unblock → `transfer_checked` → re-block sequence, and Token-2022
invokes `transfer-hook::execute` from inside the inner `transfer_checked`. The
hook is where all compliance is enforced (deactivation, transfer-mode /
whitelist, frozen account, frozen balance, functionality) — see
[`transfer-hook.md`](transfer-hook.md). This program only orchestrates the
thaw/transfer/re-freeze dance and forwards the accounts the hook's
`ExtraAccountMetaList` declares.

There is **no** `verify_transfer` pre-instruction and no instruction
introspection any more: because compliance lives in the hook, a plain
`transfer` (or a composable caller wrapping `transfer_checked` in its own CPI)
is fully gated on its own. See
[`transfer-hook-heap-oom.md`](transfer-hook-heap-oom.md) for why the checks used
to live here behind an introspection gate and why they moved back into the hook.

Owns the `["transfer", mint]` PDA, which signs the block/unblock CPIs to
`freeze` and is one of the three callers accepted by `freeze`'s auxiliary
instructions.

---

## Compute budget

The full chain (unblock ×2 → `transfer_checked` → hook → block ×2) exceeds the
default 200 K CU. Clients must raise the limit with
`ComputeBudgetProgram.setComputeUnitLimit` — ~400 K for a single `transfer`,
scaled by leg count for `batch_transfer`.

---

## Instruction: `transfer` (Operational)

Moves `amount` tokens from `source` to `destination`. Reads the mint decimals,
thaws both accounts, runs `transfer_checked` (which fires the hook), then
re-freezes both. All the trailing accounts from index 4 on are forwarded to the
inner `transfer_checked` so Token-2022 can hand them to the hook; their order
must match the hook's `ExtraAccountMetaList`.

### Parameters

```rust
amount: u64  // raw token units
```

### Accounts

| Idx | Account | Mut | Signer | Notes |
|---|---|---|---|---|
| 0 | `source_owner` | no | yes | Token-2022 enforces `source.owner == source_owner` natively |
| 1 | `source` | yes | no | Source token account |
| 2 | `destination` | yes | no | Destination token account |
| 3 | `mint` | no | no | Token-2022 mint; decimals read for `transfer_checked` |
| 4 | `transfer_authority` | no | no | seeds `["transfer", mint]` (this program); signs block/unblock CPIs |
| 5 | `freeze_authority` | no | no | seeds `["freeze_authority", mint]`, `seeds::program = FREEZE_PROGRAM_ID` |
| 6 | `extra_account_meta_list` | no | no | seeds `["extra-account-metas", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID` |
| 7 | `transfer_hook_program` | no | no | address = `TRANSFER_HOOK_PROGRAM_ID` |
| 8 | `freeze_program` | no | no | address = `FREEZE_PROGRAM_ID`; used for the freeze CPIs and forwarded to the hook |
| 9 | `deploy_program` | no | no | address = `DEPLOY_PROGRAM_ID`; forwarded (metalist resolves @6) |
| 10 | `asset_configuration_pda` | no | no | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; forwarded |
| 11 | `factory_program` | no | no | address = `FACTORY_PROGRAM_ID`; forwarded (metalist resolves @8) |
| 12 | `asset_class_version_pda` | no | no | seeds `["asset_class_version", config_id, version]` (from `asset_configuration_pda`), `seeds::program = FACTORY_PROGRAM_ID`; forwarded |
| 13 | `deactivate_program` | no | no | address = `DEACTIVATE_PROGRAM_ID`; forwarded |
| 14 | `deactivate_pda` | no | no | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; forwarded |
| 15 | `transfer_control_program` | no | no | address = `TRANSFER_CONTROL_PROGRAM_ID`; forwarded |
| 16 | `transfer_control_mode_pda` | no | no | seeds `["transfer_control_mode", mint]`; forwarded (may be empty) |
| 17 | `source_whitelist_pda` | no | no | seeds `["whitelist", mint, source]`; forwarded (must exist in whitelist mode) |
| 18 | `destination_whitelist_pda` | no | no | seeds `["whitelist", mint, destination]`; forwarded (must exist in whitelist mode) |
| 19 | `source_frozen_pda` | no | no | seeds `["frozen_account", mint, source]`; forwarded (must be empty) |
| 20 | `source_frozen_balance_pda` | no | no | seeds `["frozen_balance", mint, source]`; forwarded (may be empty) |
| 21 | `token_2022_program` | no | no | Program<Token2022> |

The whitelist/frozen PDAs are seeded by the **source token account** (not its
owner), matching the hook's metalist derivation. The block from index 6 onward
(`extra_account_meta_list` + `transfer_hook_program` + the 13 metalist entries)
is appended to `transfer_ix.accounts` before the `invoke`, in metalist order.

### Execution

1. Read `decimals` from `mint`.
2. CPI → `freeze::unblock_account(source)` then `unblock_account(destination)`, signed with `["transfer", mint, bump]`.
3. `invoke` → `transfer_checked(source, mint, destination, source_owner, amount, decimals)` with the hook accounts appended. Token-2022 invokes `transfer-hook::execute`, which runs the compliance suite + functionality gate.
4. CPI → `freeze::block_account(source)` then `block_account(destination)`.

---

## Instruction: `batch_transfer` (Operational)

One source holder fans tokens out to many destinations in a single instruction.
Unblocks the shared source once, then per destination runs unblock →
`transfer_checked` → re-block, and re-blocks the source once at the end. Each
`transfer_checked` fires the hook, which enforces compliance for that leg
(post-debit balance check composes across legs — see [`transfer-hook.md`](transfer-hook.md)).

### Parameters

```rust
amounts: Vec<u64>  // raw token units per destination
```

### Accounts

Named accounts mirror `transfer` minus the single `destination` and the
per-destination whitelist. The per-leg `(destination, destination_whitelist_pda)`
pairs are appended as `remaining_accounts`
(`remaining_accounts.len() == amounts.len() * 2`).

| Idx | Account | Notes |
|---|---|---|
| 0 | `source_owner` | Signer |
| 1 | `source` | mut; shared source token account |
| 2 | `mint` | |
| 3 | `transfer_authority` | seeds `["transfer", mint]` |
| 4 | `freeze_authority` | seeds `["freeze_authority", mint]`, `seeds::program = FREEZE_PROGRAM_ID` |
| 5 | `extra_account_meta_list` | |
| 6 | `transfer_hook_program` | address = `TRANSFER_HOOK_PROGRAM_ID` |
| 7 | `freeze_program` | address = `FREEZE_PROGRAM_ID` |
| 8 | `deploy_program` | forwarded |
| 9 | `asset_configuration_pda` | forwarded |
| 10 | `factory_program` | forwarded |
| 11 | `asset_class_version_pda` | forwarded |
| 12 | `deactivate_program` | forwarded |
| 13 | `deactivate_pda` | forwarded |
| 14 | `transfer_control_program` | forwarded |
| 15 | `transfer_control_mode_pda` | forwarded |
| 16 | `source_whitelist_pda` | forwarded (constant across legs) |
| 17 | `source_frozen_pda` | forwarded |
| 18 | `source_frozen_balance_pda` | forwarded |
| 19 | `token_2022_program` | |
| 20.. | `remaining_accounts` | per leg `i`: `destination_i` (writable) + its `destination_whitelist_pda` |

Per leg the forwarded hook block reuses every constant account and substitutes
the current leg's `destination` (index 2 of the inner `transfer_checked`) and
`destination_whitelist_pda` (metalist index 14).

### Execution

1. `require!(!amounts.is_empty())` → `EmptyBatch`; `require!(remaining_accounts.len() == amounts.len() * 2)` → `InvalidRemainingAccounts`.
2. Read `decimals`; CPI → `freeze::unblock_account(source)` once.
3. For each leg `i`: unblock `destination_i` → `invoke transfer_checked(..., amounts[i], ...)` with the hook accounts (this leg's destination + whitelist) → block `destination_i`.
4. CPI → `freeze::block_account(source)` once.

---

## Error Codes

```rust
pub enum TransferError {
    UnauthorizedTransfer,       // legacy — ownership enforced by Token-2022
    EmptyBatch,                 // amounts is empty
    InvalidRemainingAccounts,   // remaining_accounts count != amounts.len() * 2
    BatchAmountOverflow,        // legacy — sum overflow (was checked by the removed batch_verify_transfer)
}
```

Compliance errors are raised by the hook and propagate from its helpers
(`Deactivated`, `NotWhitelisted`, `AccountFrozen`, `InsufficientUnfrozenBalance`);
see [`transfer-hook.md`](transfer-hook.md).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;`.
