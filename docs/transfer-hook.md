# transfer-hook — Program Reference

Program ID: `2qjsucJfrjP93FCwnYjc9EjYzYS8u31eWHhQo1jR9pcg`

Implements the [SPL Transfer Hook Interface](https://spl.solana.com/transfer-hook-interface).
Token-2022 invokes `execute` automatically on every `transfer_checked` call for
mints that have this program registered in their `TransferHook` extension.

This is where the whole transfer compliance suite lives. Two responsibilities:

1. **Compliance gate.** Runs every transfer rule against the accounts Token-2022
   forwards from the `ExtraAccountMetaList`: mint not deactivated, transfer-mode
   / whitelist (source and destination), source not fully frozen, and the source's
   partial-freeze lock still covered after the debit.
2. **Functionality gate.** Reads the mint's `asset_configuration_pda` to locate
   its `asset_class_version_pda` and requires the `TRANSFER_HOOK_EXECUTE` bit to
   be enabled.

There is no instruction introspection and no `Instructions` sysvar read: the hook
does not care what top-level instruction it was reached from, which is what makes
transfers composable. Every path — a bare `Token-2022::transfer_checked`,
`transfer::batch_transfer`, `operations::controller_transfer`, or a third-party
program CPI'ing any of them — passes through the same checks here. Earlier
revisions did introspect, because the compliance accounts did not fit
Token-2022's 32 KiB heap at the time (see
[Metalist contents](#metalist-contents), which is still the binding constraint).

The one exemption is the **permanent-delegate bypass**: when the transfer
authority is the `["permanent_delegate", mint]` PDA, `execute` returns
successfully without running any check, because only `operations` can sign those
seeds and `operations::controller_transfer` is itself fully gated (see
[Permanent-delegate bypass](#permanent-delegate-bypass)).

The hook writes **no state at all** — it only reads and either passes or
aborts the transfer.

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
| `extra_account_meta_list` | yes | no | AccountInfo | init; seeds `["extra-account-metas", mint]`; size = `ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_META_COUNT)` (currently 15) |
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
| 18 | `hold` program | literal pubkey — resolves @19 |
| 19 | `source_hold_position_pda` | external PDA via @18 — seeds `["hold_position", mint@1, source_token@0]` |

Every entry is read-only; the hook never writes. Because Token-2022 derives the
seed-based entries and verifies the caller-supplied accounts against them before
invoking the hook, each forwarded PDA is guaranteed canonical by the time
`execute` runs.

> **Metalist size is a hard budget — measure before adding entries.** Resolving
> this list (TLV-decoding the PDA, deriving each seeded entry with
> `find_program_address`, building the CPI's `Vec<AccountMeta>` and
> `Vec<AccountInfo>`) happens *inside Token-2022*, on a heap the SDK hard-codes to
> 32 KiB — `solana-program-entrypoint`'s default bump allocator, which Token-2022
> does not override. `ComputeBudgetProgram.requestHeapFrame` does **not** lift it:
> the runtime maps the larger region, but the allocator was compiled believing it
> has 32 KiB and never looks past that boundary. Only the SPL maintainers can
> change that, so the list is the only lever we have.
>
> A 16-entry list once exceeded it, and the failure mode is unmistakable and
> unhelpful: `Error: memory allocation failed, out of memory` logged by
> `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` with plenty of CU left, and the
> hook never invoked at all. Two things bought back the room the compliance
> entries now use — the hook stopped writing per-holder balance snapshots (six
> entries: the snapshot program, `snapshot_counter`, sender/receiver snapshot PDAs,
> the `transfer_hook_authority` payer and the system program; balances are
> committed to one Merkle root per snapshot instead), and transfers stopped
> thawing/re-freezing accounts around the movement.

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

Indices 0–4 are fixed by the SPL interface; 5–19 are the metalist entries above,
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
| 18 | `hold_program` |
| 19 | `source_hold_position_pda` |

### Execution

1. `require_transferring(&source_token)` — unpack the source token account's
   `TransferHookAccount` extension and require its `transferring` flag. Token-2022
   sets that flag only for the duration of a transfer, so this is what stops
   anyone from calling `execute` directly to probe or grief. Failure (unpack error
   or flag unset) → `NotTransferring`.
2. **Permanent-delegate bypass** — if `owner` (the transfer authority) is the
   `["permanent_delegate", mint]` PDA of `operations`, return `Ok(())` now,
   skipping steps 3–6. See [below](#permanent-delegate-bypass).
3. `require_active(&deactivate_pda)` — the mint must not be deactivated.
4. `transfer_control::verify_transfer_control_mode(&transfer_control_mode_pda,
   &[&source_whitelist_pda, &destination_whitelist_pda])` — a no-op when
   `transfer_control_mode_pda` is empty (no mode active); in whitelist mode both
   markers must exist, else `NotWhitelisted`.
5. `freeze::require_unfrozen_account(&source_frozen_pda)` — the source must not be
   fully frozen, else `AccountFrozen`.
6. Sum `freeze::frozen_balance(&source_frozen_balance_pda)?` and
   `common::held_amount(&source_hold_position_pda)?`, then
   `freeze::require_locked_balance_covered(&source_token, total_locked)` — every
   lien on the account must still be covered. The hook runs **post-debit**, so this
   asserts `balance_post >= frozen + held` (the pre-debit `available >= amount`
   restated), else `InsufficientUnfrozenBalance`. The two liens are independent:
   `frozen` comes from a management partial freeze, `held` is the sum of the
   account's active holds (0 when the position PDA does not exist). See
   [`docs/hold.md`](hold.md).
7. `require_functionality(asset_class_version_pda, TRANSFER_HOOK_EXECUTE)` — the
   asset-class version this mint is pinned to must have the hook's execute bit
   enabled.

Then it returns. The hook performs no CPI and mutates no account, so it adds
nothing to the transfer's write set beyond what Token-2022 itself touches.

The `amount` argument is unused: every check reads state directly, and the
post-debit balance check needs no amount.

Source ownership is intentionally **not** re-checked here: Token-2022's
`transfer_checked` enforces `source.owner == authority` before invoking the
hook. Pause is not checked either — Token-2022 rejects a transfer on a paused
mint before the hook runs.

---

## Why compliance lives here (and not in a pre-instruction)

Enforcing the rules inside `execute` means they hold for **every** way tokens can
move, with no cooperation required from the caller. A bare
`Token-2022::transfer_checked`, `transfer::batch_transfer`, a third-party program
CPI'ing either one — all of them go through this code, because Token-2022 invokes
the hook from inside the transfer itself. There is no transaction layout to get
right, nothing for an integrator to forget, and no ordering assumption that a
future wrapper could break.

The previous design achieved the same guarantee the hard way: the compliance
suite lived in a `transfer::verify_transfer` instruction, and the hook read the
`Instructions` sysvar to require it at index N-1 with matching arguments, plus a
whitelist of legal instructions at index N to stop a wrapper from interposing.
That was forced by Token-2022's 32 KiB heap — the metalist could not carry the
compliance PDAs at the time — and it cost composability (mandatory two-instruction
layout), a TOCTOU window between the check and the movement, and a large
argument-matching surface that had to be exhaustively right to be safe.

Moving the checks back into the hook removes all of that: no sysvar read, no
discriminator or layout constants to keep in sync with other programs (`constants.rs`
is gone), no pre-instruction, and the check now runs against the same accounts
Token-2022 has already verified against the metalist. It became affordable because
the metalist had shrunk elsewhere — see the size note under
[Metalist contents](#metalist-contents).

### Permanent-delegate bypass

`execute` returns early, running no compliance check at all, when the transfer
authority is the `["permanent_delegate", mint]` PDA owned by `operations`. This is
what makes `operations::controller_transfer` a genuine seizure path: a controller
can move tokens out of a frozen or non-whitelisted account, or into one.

It is not a hole a holder can reach. Token-2022 verifies that the authority signed
the transfer, and only `operations` can produce that signature via
`invoke_signed` on those seeds — so the only way to enter this branch is through
`operations::controller_transfer`, which is itself gated on `ROLE_CONTROLLER`,
`require_active` and the `OPERATIONS_CONTROLLER_TRANSFER` functionality bit (see
[`operations.md`](operations.md)).

Note the bypass precedes *all* the checks, including deactivation and
`TRANSFER_HOOK_EXECUTE`; `controller_transfer` runs its own `require_active` and
its own functionality gate instead, so a deactivated mint still blocks the seizure —
just one level up.

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

The hook no longer has a `constants.rs` — it held the discriminators of the
instructions the removed introspection check compared against.
