# transfer-hook — Program Reference

Program ID: `2qjsucJfrjP93FCwnYjc9EjYzYS8u31eWHhQo1jR9pcg`

Implements the [SPL Transfer Hook Interface](https://spl.solana.com/transfer-hook-interface).
Token-2022 invokes `execute` automatically on every `transfer_checked` call for
mints that have this program registered in their `TransferHook` extension.

This is where the whole transfer compliance suite lives. Two responsibilities:

1. **Compliance gate.** Runs every transfer rule against the accounts Token-2022
   forwards from the `ExtraAccountMetaList`: mint not deactivated, transfer-mode
   / control list (source and destination), source not fully frozen, and the source's
   partial-freeze lock still covered after the debit.
2. **Functionality gate.** Requires the mint's `MintCompliance` record to have
   `transfer_hook_execute_enabled` set — `deploy_mint`'s copy of the asset-class
   version's `TRANSFER_HOOK_EXECUTE` bit (see [State](#state-compliance-registry)).

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

`execute` writes **no state at all** — it only reads and either passes or aborts
the transfer. The hook's other instructions are auxiliary, CPI-only writers for its
mint-scoped PDAs and compliance records (see [PDAs](#pdas)).

---

## PDAs

| Seeds | Purpose |
|---|---|
| `["transfer_hook_authority", mint]` | Token-2022 TransferHook extension authority. Recorded on the mint by `deploy_mint`; not passed to `execute` and never used as a signer |
| `["extra-account-metas", mint]` | SPL `ExtraAccountMetaList` — declares which extra accounts Token-2022 forwards to `execute` |
| `["mint_compliance", mint]` | `MintCompliance` — per-mint compliance record (see [State](#state-compliance-registry)) |
| `["account_compliance", mint, token_account]` | `AccountCompliance` — per-`(mint, token account)` compliance record (see [State](#state-compliance-registry)) |

---

## State: compliance registry

The hook owns two records that hold all the state `execute` reads, so the metalist needs only one fixed entry for the mint plus one derived entry per side of the transfer, and no program entries (the records are hook-owned). This is Option C of the *Transfer-hook metalist reduction* ADR. Each capability program keeps its own instructions, roles and events. It writes only its own fields, through a hook auxiliary instruction signed by its own PDA. The registry is filled in one capability at a time. Today `MintCompliance` is created by `deploy_mint` (through [`initialize_extra_account_meta_list`](#instruction-initialize_extra_account_meta_list-auxiliary)) and `deactivate` sets its `deactivated` flag (through [`set_deactivated`](#instruction-set_deactivated-auxiliary)); `freeze` writes both freeze fields of `AccountCompliance` (through [`set_freeze`](#instruction-set_freeze-auxiliary)); `transfer-control` writes `transfer_mode` and `in_control_list` (through [`set_transfer_mode`](#instruction-set_transfer_mode-auxiliary) and [`set_in_control_list`](#instruction-set_in_control_list-auxiliary)). `execute` reads all of these. `held_amount` is not written yet, and `execute` still reads the hold lien from `hold`'s `hold_position` until that migration lands.

Both are **zero-copy** (`#[account(zero_copy)]`, `#[repr(C)]`). The canonical definitions live in `transfer_hook::state`. `common::state` has field-for-field mirrors so that readers which cannot depend on `transfer-hook` (`mint`, `hold`, `operations`, …) can load them with `AccountLoader::<T>::try_from`. Compile-time size and discriminator asserts in `transfer-hook/src/state.rs` keep the two definitions in sync. A round-trip test there catches a same-size field reorder, and offset tests in `common/src/state/compliance.rs` pin every offset.

**Layout rules (append-only).** Readers in other programs read these bytes directly, and they cannot all be upgraded in the same transaction as the hook. So:
- never reorder, resize or remove a field;
- a new field is carved out of `_reserved`, which is zero on every existing account, so `0` must mean "unset / not applicable" for any new field;
- bump `COMPLIANCE_LAYOUT_VERSION` (`version` field) when the meaning of the layout changes, so readers can tell old records from new ones;
- `mint` stays at offset 8 (right after the discriminator), so `getProgramAccounts` + `memcmp(offset = 8, mint)` lists every record of a mint off-chain.

Booleans are stored as `u8` (`0` = false, non-zero = true) because `bool` is not `Pod`. Use the `is_*` helpers on the `common` mirrors.

### `MintCompliance` — `["mint_compliance", mint]`

| Offset¹ | Field | Type | Written by | Meaning |
|---|---|---|---|---|
| 0 | `mint` | `Pubkey` | `deploy` (creation) | The mint this record belongs to |
| 32 | `version` | `u8` | hook | Layout version (`COMPLIANCE_LAYOUT_VERSION`) |
| 33 | `bump` | `u8` | hook | PDA bump |
| 34 | `deactivated` | `u8` (bool) | `deactivate` (via [`set_deactivated`](#instruction-set_deactivated-auxiliary)) | Mint permanently deactivated. The single deactivation source of truth: `execute` reads it directly, every other program through `common::require_active` |
| 35 | `transfer_mode` | `u8` | `transfer-control` (via [`set_transfer_mode`](#instruction-set_transfer_mode-auxiliary)) | `TRANSFER_MODE_NONE` (0) / `TRANSFER_MODE_WHITELIST` (1) / `TRANSFER_MODE_BLACKLIST` (2). `NONE` = no list check. Set once by `transfer-control::initialize` |
| 36 | `transfer_hook_execute_enabled` | `u8` (bool) | `deploy` (creation) | Copy of the version's `TRANSFER_HOOK_EXECUTE` functionality bit, so `execute` no longer needs `asset_configuration` → factory → `asset_class_version` (3 metalist entries) to read one bit. The copy stays exact because a mint never changes asset-class version and a `Finalized` version is immutable; any future "migrate mint to version N" instruction must refresh it. Another functionality the hook needs later gets its own flag from `_reserved` |
| 37 | `_padding` | `[u8; 3]` | — | Not required by `Pod` (the struct is 1-aligned); keeps `_reserved` at an 8-byte offset so a future `u64` carved from it stays aligned |
| 40 | `_reserved` | `[u8; 128]` | — | Future per-mint fields (e.g. External Eligibility list config) |

Total: 8 + 168 = **176 bytes**.

### `AccountCompliance` — `["account_compliance", mint, token_account]`

| Offset¹ | Field | Type | Written by | Meaning |
|---|---|---|---|---|
| 0 | `mint` | `Pubkey` | hook (creation) | Mint of the token account. Already in the seeds; stored so the records can be enumerated with `memcmp` |
| 32 | `token_account` | `Pubkey` | hook (creation) | The token account this record belongs to |
| 64 | `frozen_balance` | `u64` | `freeze` (via [`set_freeze`](#instruction-set_freeze-auxiliary)) | Partial-freeze lien; `0` = none |
| 72 | `held_amount` | `u64` | `hold` (planned) | Sum of active hold liens. Moved (not copied) out of `HoldPosition`, which keeps only `hold_count` |
| 80 | `version` | `u8` | hook | Layout version |
| 81 | `bump` | `u8` | hook | PDA bump |
| 82 | `in_control_list` | `u8` (bool) | `transfer-control` (via [`set_in_control_list`](#instruction-set_in_control_list-auxiliary)) | Control-list membership |
| 83 | `fully_frozen` | `u8` (bool) | `freeze` (via [`set_freeze`](#instruction-set_freeze-auxiliary)) | Full freeze |
| 84 | `_padding` | `[u8; 4]` | — | Alignment |
| 88 | `_reserved` | `[u8; 64]` | — | Future per-account fields |

Total: 8 + 152 = **160 bytes**.

¹ Offset within the struct; add 8 for the discriminator to get the offset in the account data.

**Membership is a flag, not existence.** An `AccountCompliance` record can exist because the account is frozen (or, later, held) without being listed, so membership must always be read from `in_control_list`, never from whether the record exists. An absent record means "every field is zero". The record is created the first time a capability writes one of its fields and is **never closed**, since it is shared by every capability.

**Seeds keep the mint** even though a token account address is already unique across mints. This keeps the derivation the same shape as every other per-account PDA in the workspace, so Token-2022 can resolve it from metalist indices 0/1/2 with no data lookup.

---

## Instruction: `initialize_extra_account_meta_list` (Auxiliary)

Creates the hook's per-mint state: the `ExtraAccountMetaList` PDA and the mint's
`MintCompliance` record. Called exclusively via CPI from `deploy::deploy_mint`,
authorised by requiring `asset_configuration_pda` as `Signer` — only `deploy` can
produce that signature.

Both accounts are created in this one call because `deploy_mint` runs close to the
default 200k CU budget: a separate CPI for `MintCompliance` (its own dispatch, its own
`asset_configuration_pda` seed check and PDA search) pushed it over. Here the record's
address is derived once, by its `init` constraint, and reused as the metalist literal.

`transfer_hook_execute_enabled` arrives as an argument rather than being read from
the asset-class version: during the CPI, `deploy_mint`'s `asset_configuration_pda`
is allocated but its data is only serialized when `deploy_mint` returns, so the hook
cannot locate the version through it. Trusting the argument is equivalent to
trusting the signer. The copy stays exact because a mint never changes asset-class
version and a `Finalized` version is immutable; any future "migrate mint to version
N" instruction must refresh it.

### Parameters

```rust
transfer_hook_execute_enabled: bool  // the version's TRANSFER_HOOK_EXECUTE bit, read by deploy_mint
```

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Funds rent |
| `asset_configuration_pda` | no | yes | UncheckedAccount | Signer proves the call originates from `deploy_mint`; seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `extra_account_meta_list` | yes | no | AccountInfo | init; seeds `["extra-account-metas", mint]`; size = `ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_META_COUNT)` (currently 10) |
| `mint_compliance_pda` | yes | no | `AccountLoader<MintCompliance>` | init; seeds `["mint_compliance", mint]`. Gets `mint`, `version = COMPLIANCE_LAYOUT_VERSION`, `bump` and `transfer_hook_execute_enabled`; every other field starts at zero (not deactivated, no transfer mode) |
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
| 5 | `mint_compliance_pda` | literal pubkey — `["mint_compliance", mint]` of this program, created by the same call |
| 6 | `source_account_compliance_pda` | PDA of this program — seeds `["account_compliance", mint@1, source_token@0]` |
| 7 | `destination_account_compliance_pda` | PDA of this program — seeds `["account_compliance", mint@1, destination_token@2]` |
| 8 | `hold` program | literal pubkey — resolves @9 |
| 9 | `source_hold_position_pda` | external PDA via @8 — seeds `["hold_position", mint@1, source_token@0]` |

**Mint-only PDAs are literals.** Each mint has its own metalist, written once by
`deploy_mint`, so a PDA whose seeds depend only on the mint has a fixed address for
the metalist's whole life. Storing that address as a literal instead of an external
PDA means its owning program does not need an entry of its own to resolve it — which
is why `deploy` is not in the list at all, and why the hook's own `mint_compliance`
needs no program entry either. A PDA seeded by a token account must be derived per
transfer, but when it belongs to the hook itself (`account_compliance`) Token-2022
derives it from the hook's program id, so it needs no program entry; only external
ones (today just `hold_position`) still need their program listed. The hook's
own `seeds` constraints re-check every one of these addresses, so a wrong literal
would fail transfers, not admit them.

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
> The full freeze and the partial freeze used to be two entries
> (`["frozen_account", …]` and `["frozen_balance", …]`); merging them into the
> single (former) `freeze_state` PDA freed one slot.
> Storing the mint-only PDAs as literals then dropped the `deploy` and `deactivate`
> program entries (12 entries). Reading the `TRANSFER_HOOK_EXECUTE` bit from
> `MintCompliance` instead of following `asset_configuration` → factory →
> `asset_class_version` replaced those three entries with one literal (10 entries),
> and reading deactivation from `MintCompliance.deactivated` instead of the
> former `["deactivate", mint]` marker dropped one more (9 entries). Moving the freeze
> state into the hook's own `AccountCompliance` dropped the `freeze` program entry
> (8 entries). Moving the transfer mode and control-list membership into the registry
> replaced the `transfer-control` program, the mode literal and both `control_list`
> PDAs with the destination's `AccountCompliance`, leaving 5 entries with 3 PDA
> derivations — ten slots below the 15 this list is known to resolve at. Literals are also the cheapest entry for
> the heap: they derive nothing, and Token-2022's bump allocator never frees what a
> derivation allocates.
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

## Instruction: `set_deactivated` (Auxiliary)

Sets `MintCompliance.deactivated` for a mint. Called exclusively via CPI from
`deactivate::deactivate`. Authorised by requiring `deactivate`'s
`["registry_writer"]` PDA as `Signer` (checked with `seeds::program =
DEACTIVATE_PROGRAM_ID`) — only `deactivate` can produce that signature, so no other
program can deactivate a mint through the registry. It writes that one field and
nothing else; role, functionality and pause checks stay in `deactivate`.

There is no way to clear the flag: deactivation is permanent.

### Parameters

None.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `registry_writer` | no | yes | Signer | seeds `["registry_writer"]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| `mint_compliance_pda` | yes | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]`; created by `deploy_mint`, so it always exists |
| `mint` | no | no | UncheckedAccount | Seed component |

---

## Instruction: `set_freeze` (Auxiliary)

Writes both freeze fields (`fully_frozen`, `frozen_balance`) of a token account's
`AccountCompliance`, creating the record (`init_if_needed`, paid by `payer`) on first
use and stamping `mint`, `token_account`, `version` and `bump` then. Called
exclusively via CPI from the `freeze` management instructions, which read the
current state with `common::freeze_status`, validate the transition, and pass both
sides (the untouched side unchanged). Authorised by requiring `freeze`'s
`["registry_writer"]` PDA as `Signer` (checked with `seeds::program =
FREEZE_PROGRAM_ID`); role, functionality, pause and state-transition checks stay in
`freeze`. It writes no other field.

### Parameters

```rust
fully_frozen: bool
frozen_balance: u64  // 0 = no partial freeze
```

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `registry_writer` | no | yes | Signer | seeds `["registry_writer"]`, `seeds::program = FREEZE_PROGRAM_ID` |
| `payer` | yes | yes | Signer | Funds the record on first use (the freeze authority) |
| `account_compliance_pda` | yes | no | `AccountLoader<AccountCompliance>` | `init_if_needed`; seeds `["account_compliance", mint, token_account]` |
| `mint` | no | no | UncheckedAccount | Seed component |
| `token_account` | no | no | UncheckedAccount | Seed component |
| `system_program` | no | no | Program<System> | |

---

## Instruction: `set_transfer_mode` (Auxiliary)

Writes `MintCompliance.transfer_mode`. Called exclusively via CPI from
`transfer-control::initialize`, which enforces that the mode is set only once.
Authorised by requiring `transfer-control`'s `["registry_writer"]` PDA as `Signer`
(`seeds::program = TRANSFER_CONTROL_PROGRAM_ID`). Rejects any value other than
`TRANSFER_MODE_WHITELIST` / `TRANSFER_MODE_BLACKLIST` with `InvalidTransferMode`.

### Parameters

```rust
transfer_mode: u8  // 1 = Whitelist, 2 = Blacklist
```

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `registry_writer` | no | yes | Signer | seeds `["registry_writer"]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID` |
| `mint_compliance_pda` | yes | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]` |
| `mint` | no | no | UncheckedAccount | Seed component |

---

## Instruction: `set_in_control_list` (Auxiliary)

Writes `AccountCompliance.in_control_list` for a token account, creating the record
(`init_if_needed`, paid by `payer`) on first use, like `set_freeze`. Called
exclusively via CPI from `transfer-control::add_to_control_list` (`true`) and
`remove_from_control_list` (`false`), authorised by `transfer-control`'s
`["registry_writer"]` PDA. It writes no other field.

### Parameters

```rust
in_control_list: bool
```

### Accounts

Same as [`set_freeze`](#instruction-set_freeze-auxiliary), with `registry_writer`
checked against `TRANSFER_CONTROL_PROGRAM_ID`.

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

Indices 0–4 are fixed by the SPL interface; 5–9 are the metalist entries above,
in order.

| Index | Account |
|---|---|
| 0 | `source_token` |
| 1 | `mint` |
| 2 | `destination_token` |
| 3 | `owner` (transfer authority) |
| 4 | `extra_account_meta_list` |
| 5 | `mint_compliance_pda` (`AccountLoader<MintCompliance>`; owner, discriminator and seeds checked by Anchor) |
| 6 | `source_account_compliance_pda` (may be empty — nothing recorded) |
| 7 | `destination_account_compliance_pda` (may be empty — nothing recorded) |
| 8 | `hold_program` |
| 9 | `source_hold_position_pda` |

### Execution

1. `require_transferring(&source_token)` — unpack the source token account's
   `TransferHookAccount` extension and require its `transferring` flag. Token-2022
   sets that flag only for the duration of a transfer, so this is what stops
   anyone from calling `execute` directly to probe or grief. Failure (unpack error
   or flag unset) → `NotTransferring`.
2. **Permanent-delegate bypass** — if `owner` (the transfer authority) is the
   `["permanent_delegate", mint]` PDA of `operations`, return `Ok(())` now,
   skipping steps 3–6. See [below](#permanent-delegate-bypass).
3. `mint_compliance_pda.deactivated` must be clear, else `CommonError::Deactivated`
   (the same flag and error as `common::require_active`, read inline here because
   the record is loaded once for this step, step 4 and step 7).
4. `common::verify_transfer_control_mode(mint_compliance.transfer_mode,
   &[&source_account_compliance_pda, &destination_account_compliance_pda])` — a
   no-op when no mode is set; in Whitelist mode both accounts' `in_control_list`
   must be set, else `NotWhitelisted`; in Blacklist mode neither may be set, else
   `Blacklisted` (an absent record counts as "not listed").
5. `common::freeze_status(&source_account_compliance_pda)` — reads both freeze sides
   from the source's `AccountCompliance` (absent = nothing frozen). The source must
   not be fully frozen, else `CommonError::AccountFrozen`.
6. Sum the status's partially frozen balance and
   `common::held_amount(&source_hold_position_pda)?`, then
   `common::require_locked_balance_covered(&source_token, total_locked)` — every
   lien on the account must still be covered. The hook runs **post-debit**, so this
   asserts `balance_post >= frozen + held` (the pre-debit `available >= amount`
   restated), else `InsufficientUnfrozenBalance`. The two liens are independent:
   `frozen` comes from a management partial freeze, `held` is the sum of the
   account's active holds (0 when the position PDA does not exist). See
   [`docs/hold.md`](hold.md).
7. `mint_compliance_pda.transfer_hook_execute_enabled` must be set, else
   `CommonError::FunctionalityNotSupportedError` — the same error
   `require_functionality` raised before, so clients see no change. The flag is
   `deploy_mint`'s copy of the version's `TRANSFER_HOOK_EXECUTE` bit; there is no
   separate "version finalized" check because `deploy_mint` only accepts finalized
   versions.

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
allow-list of legal instructions at index N to stop a wrapper from interposing.
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
can move tokens out of a frozen or unlisted account, or into one.

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
    InvalidTransferMode,  // set_transfer_mode with a value other than Whitelist (1) / Blacklist (2)
}
```

Compliance failures propagate from the helpers the hook calls:
`common::CommonError::{Deactivated, NotWhitelisted, Blacklisted}`,
`common::CommonError::{AccountFrozen, InsufficientUnfrozenBalance}`, and
`common::CommonError::FunctionalityNotSupportedError` when the mint's
`MintCompliance` copy of `TRANSFER_HOOK_EXECUTE` is off.

---

## Program IDs

All program IDs are imported from `common::program_ids`:

```rust
use common::program_ids::{DEPLOY_PROGRAM_ID, HOLD_PROGRAM_ID, /* … */};
```

The hook no longer has a `constants.rs` — it held the discriminators of the
instructions the removed introspection check compared against.
