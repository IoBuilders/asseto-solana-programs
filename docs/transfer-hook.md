# transfer-hook — Program Reference

Program ID: `2qjsucJfrjP93FCwnYjc9EjYzYS8u31eWHhQo1jR9pcg`

Implements the [SPL Transfer Hook Interface](https://spl.solana.com/transfer-hook-interface).
Token-2022 invokes `execute` automatically on every `transfer_checked` call for
mints that have this program registered in their `TransferHook` extension.

The hook is where **all** transfer compliance is enforced. It runs the full rule
suite itself and writes no state — it only reads and either passes or aborts the
transfer. Running the checks in the hook (rather than in a separate top-level
`verify_transfer` gated by instruction introspection) is what makes the token
composable: any caller — a wallet, a DEX, a custodian, a multisig — can invoke a
plain `transfer_checked` (directly or wrapped in its own CPI) and the hook still
enforces compliance. See [`transfer-hook-heap-oom.md`](transfer-hook-heap-oom.md)
for the history: compliance used to live in `transfer::verify_transfer` behind an
introspection gate because the larger `ExtraAccountMetaList` once exhausted
Token-2022's 32 KiB heap; that constraint is no longer binding at the current
metalist size, so the checks moved back into the hook.

Responsibilities of `execute`, in order:

1. **Transfer guard.** Reject any invocation where the source token account is
   not in Token-2022's transient `transferring` state, so `execute` cannot be
   used as a standalone compliance oracle.
2. **Controller bypass.** If the transfer authority is the mint's
   `["permanent_delegate", mint]` PDA, this is an `operations::controller_transfer`
   force-transfer — already gated by controller role + functionality — so the
   hook returns immediately, bypassing the whitelist / frozen checks (a seizure
   may target frozen or non-whitelisted accounts). Only `operations` can sign
   with that PDA, so the bypass is not reachable by a normal holder.
3. **Compliance suite** (skipped for the controller path): deactivation,
   transfer-mode / whitelist, frozen-account marker, and available-balance
   against the partial-freeze lock.
4. **Functionality gate.** The mint's asset-class version must have the
   `TRANSFER_HOOK_EXECUTE` bit enabled.

Owns two mint-scoped PDAs: `["transfer_hook_authority", mint]` (the Token-2022
extension authority, set on the mint at deploy time) and
`["extra-account-metas", mint]` (the SPL `ExtraAccountMetaList`).

---

## PDAs

| Seeds | Purpose |
|---|---|
| `["transfer_hook_authority", mint]` | Token-2022 TransferHook extension authority. Recorded on the mint by `deploy_mint`; not passed to `execute` and never used as a signer |
| `["extra-account-metas", mint]` | SPL `ExtraAccountMetaList` — declares which extra accounts Token-2022 forwards to `execute` |

---

## Instruction: `initialize_extra_account_meta_list` (Auxiliary)

Creates and populates the `ExtraAccountMetaList` PDA. Called exclusively via CPI
from `deploy::deploy_mint`, authorised by requiring `asset_configuration_pda` as
`Signer` — only `deploy` can produce that signature.

### Parameters

None.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Funds rent |
| `asset_configuration_pda` | no | yes | UncheckedAccount | Signer proves the call originates from `deploy_mint`; seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `extra_account_meta_list` | yes | no | AccountInfo | init; seeds `["extra-account-metas", mint]`; size = `ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_META_COUNT)` (currently 13) |
| `mint` | no | no | UncheckedAccount | Seed component and PDA-precompute input |
| `system_program` | no | no | Program<System> | |
| `rent` | no | no | Sysvar<Rent> | |

### Metalist contents

The metalist declares every account `execute` reads. Token-2022 resolves each
entry (deriving the seed-based PDAs itself) and forwards it to the hook, so this
list is both the hook's account contract and the OOM-sensitive surface (its
resolution runs on Token-2022's 32 KiB heap). Indices 0–4 are fixed by the SPL
interface (`source_token`, `mint`, `destination_token`, `owner`,
`extra_account_meta_list`); the extras below start at 5.

| Hook idx | Entry | Kind |
|---|---|---|
| 5 | `deploy` program | literal pubkey — resolves @6 |
| 6 | `asset_configuration_pda` | external PDA via @5 — seeds `["asset_configuration", mint@1]` |
| 7 | `factory` program | literal pubkey — resolves @8 |
| 8 | `asset_class_version_pda` | external PDA via @7 — seeds `["asset_class_version", @6.asset_class_config_id, @6.asset_class_version_id]` |
| 9 | `deactivate` program | literal pubkey — resolves @10 |
| 10 | `deactivate_pda` | external PDA via @9 — seeds `["deactivate", mint@1]` |
| 11 | `transfer-control` program | literal pubkey — resolves @12..=14 |
| 12 | `transfer_control_mode_pda` | external PDA via @11 — seeds `["transfer_control_mode", mint@1]` |
| 13 | `source_whitelist_pda` | external PDA via @11 — seeds `["whitelist", mint@1, source_token@0]` |
| 14 | `destination_whitelist_pda` | external PDA via @11 — seeds `["whitelist", mint@1, destination_token@2]` |
| 15 | `freeze` program | literal pubkey — resolves @16..=17 |
| 16 | `source_frozen_pda` | external PDA via @15 — seeds `["frozen_account", mint@1, source_token@0]` |
| 17 | `source_frozen_balance_pda` | external PDA via @15 — seeds `["frozen_balance", mint@1, source_token@0]` |

Every entry is read-only; the hook never writes. Because Token-2022 derives the
seed-based entries and verifies the caller-supplied accounts against them before
invoking the hook, each forwarded PDA is guaranteed canonical by the time
`execute` runs.

---

## Instruction: `execute` (SPL Transfer Hook Interface)

### Parameters

```rust
amount: u64  // unused by the current logic; the post-debit balance check reads state directly
```

### Discriminator

`[105, 37, 101, 197, 75, 251, 102, 26]` — first 8 bytes of
`sha256("spl-transfer-hook-interface:execute")`. Token-2022 uses this exact
discriminator when invoking the hook during `transfer_checked`.

### Accounts

Indices 0–4 are fixed by the SPL interface; 5–17 are the metalist entries above,
in order.

| Index | Account |
|---|---|
| 0 | `source_token` |
| 1 | `mint` |
| 2 | `destination_token` |
| 3 | `owner` (transfer authority) |
| 4 | `extra_account_meta_list` |
| 5 | `deploy_program` |
| 6 | `asset_configuration_pda` |
| 7 | `factory_program` |
| 8 | `asset_class_version_pda` |
| 9 | `deactivate_program` |
| 10 | `deactivate_pda` |
| 11 | `transfer_control_program` |
| 12 | `transfer_control_mode_pda` |
| 13 | `source_whitelist_pda` |
| 14 | `destination_whitelist_pda` |
| 15 | `freeze_program` |
| 16 | `source_frozen_pda` |
| 17 | `source_frozen_balance_pda` |

### Execution

1. **Transfer guard** — unpack `source_token`'s `TransferHookAccount` extension
   and require `transferring == true`, else `NotTransferring`.
2. **Controller bypass** — derive `["permanent_delegate", mint]` under
   `OPERATIONS_PROGRAM_ID` and, if it equals `owner`, return `Ok` (skip all
   compliance). Safe because only `operations::controller_transfer` can present
   that PDA as the transfer authority.
3. `require_active(deactivate_pda)` — mint not deactivated.
4. `verify_transfer_control_mode(transfer_control_mode_pda, [source_whitelist_pda, destination_whitelist_pda])`
   — no-op if no mode active; in whitelist mode both source and destination must
   be whitelisted.
5. `require_unfrozen_account(source_frozen_pda)` — source not fully frozen.
6. `require_frozen_balance_covered(source_token, source_frozen_balance_pda)` —
   the **post-debit** balance still covers the partial-freeze lock (see below).
7. `require_functionality(asset_class_version_pda, TRANSFER_HOOK_EXECUTE)`.

Source ownership is intentionally **not** re-checked: Token-2022's
`transfer_checked` enforces `source.owner == authority` before invoking the hook.

### Post-debit balance check

Token-2022 invokes the hook **after** moving the tokens, so `source_token.amount`
is already debited. The pre-debit invariant `available >= amount`
(`balance_pre - frozen >= amount`) is algebraically `balance_post >= frozen`, so
the hook compares the post-debit balance directly against the locked amount and
does not need `amount`. For a batch the hook fires once per leg after that leg's
debit, so checking `balance_post >= frozen` at every leg keeps the cumulative
movement within the lock. Implemented by `freeze::require_frozen_balance_covered`
(see [`freeze.md`](freeze.md)).

### Compute units

The full `transfer` chain (unblock ×2 → `transfer_checked` → hook → block ×2)
exceeds the default 200 K CU budget; the hook itself consumes ~30–42 K. Callers
must raise the limit (≈400 K for a single transfer, scaled by leg count for a
batch) with `ComputeBudgetProgram.setComputeUnitLimit`.

---

## Error Codes

```rust
pub enum TransferHookError {
    InvalidAccountSize,   // ExtraAccountMetaList size mismatch during init
    NotTransferring,      // execute invoked outside a Token-2022 transfer
}
```

Compliance failures propagate from the helpers the hook calls:
`common::CommonError::Deactivated`, `transfer_control::TransferControlError::NotWhitelisted`,
`freeze::ErrorCode::{AccountFrozen, InsufficientUnfrozenBalance}`, and the
functionality errors from `common::require_functionality`.

---

## Program IDs

All program IDs are imported from `common::program_ids`:

```rust
use common::program_ids::{DEPLOY_PROGRAM_ID, FREEZE_PROGRAM_ID, /* … */};
```

The hook no longer has a `constants.rs` (it held introspection discriminators,
now removed) and no longer reads the `Instructions` sysvar.
