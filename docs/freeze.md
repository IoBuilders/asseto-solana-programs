# freeze — Program Reference

Program ID: `8L1kqDvAYC9dQXNNNnZbABtRbHGjzoxSgAPzbQZmwmSd`

Controls all programmatic freezing. A freeze is recorded in the transfer hook's per-account compliance record, `AccountCompliance` (`["account_compliance", mint, token_account]`, owned by `transfer-hook` — see [`transfer-hook.md`](transfer-hook.md#state)), which is the single source of truth for both freeze sides. This program holds no state of its own: it validates, then writes the record through a CPI to `transfer-hook::set_freeze`, signed by its `["registry_writer"]` PDA — the only writer the hook accepts for those fields (ADR option C, the same pattern `deactivate` uses for `MintCompliance.deactivated`).

No Token-2022 account state is ever changed, and no instruction here signs a Token-2022 CPI. This program owns no Token-2022 authority: mints are deployed with their freeze authority set to `None`, irreversibly (see [deploy.md](deploy.md)), so a token-level freeze is not available to it.

Exposes one category of instructions:
- **Management** (`freeze_account`, `batch_freeze_account`, `unfreeze_account`, `batch_unfreeze_account`, `freeze_account_partial`, `batch_freeze_account_partial`, `unfreeze_account_partial`, `batch_unfreeze_account_partial`): called directly by an account holding `ROLE_FREEZE_MANAGER` to enforce account-level restrictions. Each emits an event via `emit_cpi!` (see [Emitting events](#emitting-events)).

Enforcement is entirely read-side: `transfer-hook::execute` reads the record through `common::freeze_status` and aborts the transfer. A frozen account is therefore still `Initialized` (not `Frozen`) as far as Token-2022 is concerned.

---

## Freeze state (in `AccountCompliance`)

| Field | Meaning |
|---|---|
| `fully_frozen` (`u8` bool) | Full freeze (set by `freeze_account`). |
| `frozen_balance` (`u64`) | Partial freeze: amount locked; 0 = no partial freeze. |

The two sides stay **independent**: no instruction checks the other side's state, and clearing one side never touches the other. The record is created (by `set_freeze`'s `init_if_needed`, paid by `authority`) the first time either side is set, and is **never closed** — it is shared with the other compliance fields (control list, holds), so an all-clear freeze is just both fields at zero. An absent record means "nothing frozen".

The partial side is just `frozen_balance > 0`. That works because a partial freeze of 0 is **rejected** with `InvalidFreezeAmount`, matching the EVM implementation (ATS `checkNonZeroFreezeAmount` → `IFreeze.InvalidFreezeAmount`).

State matrix (∅ = no record or both sides clear; F = full; P = partial):

| From \ op | `freeze_account` | `unfreeze_account` | `freeze_account_partial(b)` | `unfreeze_account_partial` |
|---|---|---|---|---|
| ∅ | F (creates the record if absent) | `AccountNotFrozen` | P(b) (creates the record if absent) | `AccountNotPartiallyFrozen` |
| F | `AccountFrozen` | ∅ | F+P(b) | `AccountNotPartiallyFrozen` |
| P | F+P | `AccountNotFrozen` | P(b′) (overwrites) | ∅ |
| F+P | `AccountFrozen` | P | F+P(b′) | F |

`b` is always > 0: `freeze_account_partial(0)` fails with `InvalidFreezeAmount` from any state and changes nothing. The batch variants follow the same matrix per entry.

Each instruction reads the record with `common::freeze_status` (owner + discriminator checked, absent = all clear), applies its transition, and passes **both** sides to `set_freeze` — so the side it does not touch is written back unchanged.

## PDA: `registry_writer`

`["registry_writer"]` (owned by this program, no data). Signs every `transfer-hook::set_freeze` CPI; the hook accepts only this PDA as the writer of the freeze fields.

---

## Error Codes

```rust
pub enum ErrorCode {
    Unauthorized,                 // unused
    EmptyBatch,                   // batch with no entries
    InvalidRemainingAccounts,     // remaining accounts not paired with the entries
    AccountNotFrozen,             // unfreeze on an account whose full-freeze side is clear
    AccountNotPartiallyFrozen,    // partial unfreeze on an account whose partial side is clear
    InvalidFreezeAmount,          // partial freeze of 0
}
```

`AccountFrozen` (full-freeze side already set / source fully frozen), `InsufficientUnfrozenBalance` (locked amount no longer covered by the balance) and `AccountCompliancePdaMismatch` (a batch entry's `account_compliance_pda` is not the derived one, from `common::verify_account_compliance_pda`) live in `common::CommonError`, next to the shared readers they come from (`transfer-hook` and `hold` cannot depend on this crate) (see [`common.md`](common.md#function-freeze_status)).

---

## Instruction: `freeze_account` (Management)

No parameters.

Sets the full-freeze side of the account's `AccountCompliance`, creating the record if absent; an existing partial freeze is kept untouched. After this call the transfer hook rejects any transfer out of this account. Fails with `AccountFrozen` if the full-freeze side is already set (explicit check — with the merged account the PDA may legitimately exist already, so Anchor's `init` "already in use" error no longer applies).

### Preconditions

- `require_role` — signer must hold `ROLE_FREEZE_MANAGER`.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_FREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and have the `FREEZE_FREEZE_ACCOUNT` functionality bit enabled.

### Accounts

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                                    |
|---------------------------|-----|--------|----------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; pays for the `AccountCompliance` record when `set_freeze` creates it |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                                   |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`                    |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                             |
| `account`                 | no  | no     | UncheckedAccount                 | The token account to freeze; used only as a seed                                                                                         |
| `mint_compliance_pda` | no | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; `deactivated` must be 0 (checked by `require_active`) |
| `account_compliance_pda` | yes | no | UncheckedAccount | seeds `["account_compliance", mint, account]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; read by `common::freeze_status` (may be absent), created/written by the `set_freeze` CPI |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`              |
| `registry_writer` | no | no | UncheckedAccount | seeds `["registry_writer"]` (this program); signs the `set_freeze` CPI |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID`; target of the CPI |
| `system_program` | no | no | Program<System> | Required by `set_freeze` (`init_if_needed` on the record) |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountFrozen` |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI                                                    |

### Events

| Event           | Fields                                                | Emitted                                          |
|-----------------|-------------------------------------------------------|--------------------------------------------------|
| `AccountFrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After the full-freeze side is set |

---

## Instruction: `batch_freeze_account` (Management)

Freezes, in a single instruction, every account passed in via `remaining_accounts` — the batched equivalent of calling `freeze_account` once per account. Runs the same authorization checks as `freeze_account` (freeze-manager role, not paused, active, functionality) and emits one `AccountFrozen` event per account. An existing partial freeze on the entry is kept. Each entry is a `(account, account_compliance_pda)` pair in `remaining_accounts`: the PDA is checked against the derived address, read with `common::freeze_status`, and written with one `set_freeze` CPI per entry (the hook's `init_if_needed` creates the record on first use and tolerates a target a griefer pre-funded with lamports).

### Parameters

No instruction parameters — the accounts to freeze are described entirely by `remaining_accounts`.

### Remaining accounts

Two accounts per entry, in order, appended as `remaining_accounts`:

| Offset (per entry `i`) | Account              | Mut | Notes                                                                                                                 |
|------------------------|----------------------|-----|-----------------------------------------------------------------------------------------------------------------------|
| `i * 2`                | `account`            | no  | The token account to freeze; used only as a seed                                                                      |
| `i * 2 + 1` | `account_compliance_pda` | yes | Must equal the canonical `["account_compliance", mint, account]` PDA of `transfer-hook` — verified on-chain; may be absent (created by `set_freeze` when a side is set) |

### Preconditions

- `!remaining_accounts.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() % 2 == 0` — errors `InvalidRemainingAccounts` otherwise (exactly one `account_compliance_pda` per `account`).
- `require_role(ROLE_FREEZE_MANAGER)` — the `authority` caller must sign and hold `ROLE_FREEZE_MANAGER` on this mint.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_FREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and enable freezing (same functionality bit as `freeze_account`; batching doesn't get its own bit).
- Per entry: the supplied `account_compliance_pda` must match the address `Pubkey::find_program_address(["account_compliance", mint, account], TRANSFER_HOOK_PROGRAM_ID)` derives, else `AccountCompliancePdaMismatch`.
- Per entry: the full-freeze side must not already be set, else `AccountFrozen` (mirrors `freeze_account`).

### Accounts

The fixed accounts (the per-entry accounts are passed via `remaining_accounts`, see above). Note there is no `account` or `account_compliance_pda` field here — both are supplied per entry instead.

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                       |
|---------------------------|-----|--------|----------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; pays for the `AccountCompliance` record when `set_freeze` creates it |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                      |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`       |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                |
| `mint_compliance_pda` | no | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; `deactivated` must be 0 (checked by `require_active`) |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `registry_writer` | no | no | UncheckedAccount | seeds `["registry_writer"]` (this program); signs the `set_freeze` CPI |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID`; target of the CPI |
| `system_program` | no | no | Program<System> | Required by `set_freeze` (`init_if_needed` on the record) |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]`                                                           |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID                                                               |

### Errors

| Code                       | Cause                                                                                |
|----------------------------|--------------------------------------------------------------------------------------|
| `EmptyBatch`               | `remaining_accounts` is empty                                                        |
| `InvalidRemainingAccounts` | `remaining_accounts.len() % 2 != 0`                                                  |
| `AccountCompliancePdaMismatch`   | Supplied `account_compliance_pda` does not match the canonical derived PDA for `account`   |
| `AccountFrozen`            | The entry's full-freeze side is already set                                          |

### Events

| Event           | Fields                                                | Emitted                                                   |
|-----------------|-------------------------------------------------------|-----------------------------------------------------------|
| `AccountFrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After each entry's full-freeze side is set |

---

## Instruction: `unfreeze_account` (Management)

No parameters.

Clears the full-freeze side of the account's `AccountCompliance`; an existing partial freeze keeps applying. The record is never closed. Fails with `AccountNotFrozen` if the full-freeze side is not set (including when there is no record).

### Preconditions

- `require_role` (`ROLE_FREEZE_MANAGER`), `require_not_paused`, `require_active`
- `require_functionality(FREEZE_UNFREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and have the `FREEZE_UNFREEZE_ACCOUNT` functionality bit enabled.

### Accounts

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                                      |
|---------------------------|-----|--------|----------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; pays for the `AccountCompliance` record when `set_freeze` creates it |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                                     |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`                      |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                               |
| `account`                 | no  | no     | UncheckedAccount                 | The token account to unfreeze; used only as a seed                                                                                         |
| `mint_compliance_pda` | no | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; `deactivated` must be 0 (checked by `require_active`) |
| `account_compliance_pda` | yes | no | UncheckedAccount | seeds `["account_compliance", mint, account]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; read by `common::freeze_status` (may be absent), created/written by the `set_freeze` CPI |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`                |
| `registry_writer` | no | no | UncheckedAccount | seeds `["registry_writer"]` (this program); signs the `set_freeze` CPI |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID`; target of the CPI |
| `system_program` | no | no | Program<System> | Required by `set_freeze` (`init_if_needed` on the record) |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountUnfrozen` |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI                                                      |

### Events

| Event             | Fields                                                | Emitted                                          |
|-------------------|-------------------------------------------------------|--------------------------------------------------|
| `AccountUnfrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After the full-freeze side is cleared |

---

## Instruction: `batch_unfreeze_account` (Management)

Unfreezes, in a single instruction, every account passed in via `remaining_accounts` — the batched equivalent of calling `unfreeze_account` once per account. Runs the same authorization checks as `unfreeze_account` (freeze-manager role, not paused, active, functionality) and emits one `AccountUnfrozen` event per account. An existing partial freeze on the entry is kept. Each entry is a `(account, account_compliance_pda)` pair in `remaining_accounts`: the PDA is checked against the derived address, read with `common::freeze_status`, and written with one `set_freeze` CPI per entry (the hook's `init_if_needed` creates the record on first use and tolerates a target a griefer pre-funded with lamports).

### Parameters

No instruction parameters — the accounts to unfreeze are described entirely by `remaining_accounts`.

### Remaining accounts

Two accounts per entry, in order, appended as `remaining_accounts`:

| Offset (per entry `i`) | Account              | Mut | Notes                                                                                                     |
|------------------------|----------------------|-----|-------------------------------------------------------------------------------------------------------------|
| `i * 2`                | `account`            | no  | The token account to unfreeze; used only as a seed                                                          |
| `i * 2 + 1` | `account_compliance_pda` | yes | Must equal the canonical `["account_compliance", mint, account]` PDA of `transfer-hook` — verified on-chain; may be absent (created by `set_freeze` when a side is set) |

### Preconditions

- `!remaining_accounts.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() % 2 == 0` — errors `InvalidRemainingAccounts` otherwise (exactly one `account_compliance_pda` per `account`).
- `require_role(ROLE_FREEZE_MANAGER)` — the `authority` caller must sign and hold `ROLE_FREEZE_MANAGER` on this mint.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_UNFREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and enable unfreezing (same functionality bit as `unfreeze_account`; batching doesn't get its own bit).
- Per entry: the supplied `account_compliance_pda` must match the address `Pubkey::find_program_address(["account_compliance", mint, account], TRANSFER_HOOK_PROGRAM_ID)` derives, else `AccountCompliancePdaMismatch`.
- Per entry: the full-freeze side must be set (an absent record counts as clear), else `AccountNotFrozen`.

### Accounts

The fixed accounts (the per-entry accounts are passed via `remaining_accounts`, see above). Note there is no `account` or `account_compliance_pda` field here — both are supplied per entry instead.

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                       |
|---------------------------|-----|--------|----------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; pays for the `AccountCompliance` record when `set_freeze` creates it |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                      |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`       |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                |
| `mint_compliance_pda` | no | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; `deactivated` must be 0 (checked by `require_active`) |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `registry_writer` | no | no | UncheckedAccount | seeds `["registry_writer"]` (this program); signs the `set_freeze` CPI |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID`; target of the CPI |
| `system_program` | no | no | Program<System> | Required by `set_freeze` (`init_if_needed` on the record) |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]`                                                           |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID                                                               |

### Errors

| Code                       | Cause                                                                              |
|----------------------------|----------------------------------------------------------------------------------------|
| `EmptyBatch`               | `remaining_accounts` is empty                                                          |
| `InvalidRemainingAccounts` | `remaining_accounts.len() % 2 != 0`                                                    |
| `AccountCompliancePdaMismatch`   | Supplied `account_compliance_pda` does not match the canonical derived PDA for `account`     |
| `AccountNotFrozen`         | The entry's full-freeze side is clear (or it has no record)              |

### Events

| Event             | Fields                                                | Emitted                                                 |
|-------------------|---------------------------------------------------------|------------------------------------------------------------|
| `AccountUnfrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After each entry's full-freeze side is cleared |

---

## Instruction: `freeze_account_partial` (Management)

### Parameters

```rust
balance: u64  // amount to lock (must not exceed actual token balance)
```

Locks `balance` tokens of the account: sets the partial side of its `AccountCompliance`, creating the record if absent, and overwrites the locked amount on subsequent calls. An existing full freeze is kept untouched. After this call the transfer hook rejects transfers that would leave less than the locked amount in the account. `balance` must be > 0, else `InvalidFreezeAmount` (as in EVM); lifting a partial freeze is `unfreeze_account_partial`'s job.

### Preconditions

- `require_role` (`ROLE_FREEZE_MANAGER`), `require_not_paused`, `require_active`
- `require_functionality(FREEZE_PARTIALLY_FREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and have the `FREEZE_PARTIALLY_FREEZE_ACCOUNT` functionality bit enabled.

### Accounts

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                                             |
|---------------------------|-----|--------|----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; pays for the `AccountCompliance` record when `set_freeze` creates it |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                                            |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`                             |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                                      |
| `account`                 | no  | no     | UncheckedAccount                 | The token account to partially freeze; used only as a seed                                                                                        |
| `mint_compliance_pda` | no | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; `deactivated` must be 0 (checked by `require_active`) |
| `account_compliance_pda` | yes | no | UncheckedAccount | seeds `["account_compliance", mint, account]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; read by `common::freeze_status` (may be absent), created/written by the `set_freeze` CPI |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`                       |
| `registry_writer` | no | no | UncheckedAccount | seeds `["registry_writer"]` (this program); signs the `set_freeze` CPI |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID`; target of the CPI |
| `system_program` | no | no | Program<System> | Required by `set_freeze` (`init_if_needed` on the record) |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountPartiallyFrozen` |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI                                                             |

### Events

| Event                    | Fields                                                                       | Emitted                                                                                        |
|--------------------------|------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| `AccountPartiallyFrozen` | `mint: Pubkey`, `account: Pubkey`, `frozen_balance: u64`, `operator: Pubkey` | After the partial side is set/updated (`frozen_balance` is the newly-locked `balance`) |

---

## Instruction: `batch_freeze_account_partial` (Management)

Partially freezes, in a single instruction, every account passed in via `remaining_accounts`, locking `balances[i]` for the `i`-th account — the batched equivalent of calling `freeze_account_partial` once per account. Runs the same authorization checks as `freeze_account_partial` (freeze-manager role, not paused, active, functionality) and emits one `AccountPartiallyFrozen` event per account. Like the singular instruction, an existing partial freeze has its balance overwritten rather than rejected, and an existing full freeze is kept. Each entry is a `(account, account_compliance_pda)` pair in `remaining_accounts`: the PDA is checked against the derived address, read with `common::freeze_status`, and written with one `set_freeze` CPI per entry (the hook's `init_if_needed` creates the record on first use and tolerates a target a griefer pre-funded with lamports).

### Parameters

```rust
balances: Vec<u64>  // amount to lock per account; balances[i] applies to the i-th account
```

### Remaining accounts

Two accounts per entry, in order, appended as `remaining_accounts`:

| Offset (per entry `i`) | Account              | Mut | Notes                                                                                                                |
|------------------------|----------------------|-----|-----------------------------------------------------------------------------------------------------------------------|
| `i * 2`                | `account`            | no  | The token account to partially freeze; used only as a seed                                                            |
| `i * 2 + 1` | `account_compliance_pda` | yes | Must equal the canonical `["account_compliance", mint, account]` PDA of `transfer-hook` — verified on-chain; may be absent (created by `set_freeze` when a side is set) |

### Preconditions

- `!balances.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() == balances.len() * 2` — errors `InvalidRemainingAccounts` otherwise (exactly one `account_compliance_pda` per balance).
- `require_role(ROLE_FREEZE_MANAGER)` — the `authority` caller must sign and hold `ROLE_FREEZE_MANAGER` on this mint.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_PARTIALLY_FREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and enable partial freezing (same functionality bit as `freeze_account_partial`; batching doesn't get its own bit).
- Every `balances[i]` must be > 0, else `InvalidFreezeAmount` (checked up front, before any entry is written).
- Per entry: the supplied `account_compliance_pda` must match the address `Pubkey::find_program_address(["account_compliance", mint, account], TRANSFER_HOOK_PROGRAM_ID)` derives, else `AccountCompliancePdaMismatch`.

### Accounts

The fixed accounts (the per-entry accounts are passed via `remaining_accounts`, see above). Note there is no `account` or `account_compliance_pda` field here — both are supplied per entry instead.

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                       |
|---------------------------|-----|--------|----------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; pays for the `AccountCompliance` record when `set_freeze` creates it |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                      |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`       |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                |
| `mint_compliance_pda` | no | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; `deactivated` must be 0 (checked by `require_active`) |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `registry_writer` | no | no | UncheckedAccount | seeds `["registry_writer"]` (this program); signs the `set_freeze` CPI |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID`; target of the CPI |
| `system_program` | no | no | Program<System> | Required by `set_freeze` (`init_if_needed` on the record) |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]`                                                           |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID                                                               |

### Errors

| Code                       | Cause                                                                               |
|----------------------------|---------------------------------------------------------------------------------------|
| `EmptyBatch`               | `balances` is empty                                                                   |
| `InvalidRemainingAccounts` | `remaining_accounts.len() != balances.len() * 2`                                       |
| `InvalidFreezeAmount`      | Some `balances[i]` is 0                                                                 |
| `AccountCompliancePdaMismatch`   | Supplied `account_compliance_pda` does not match the canonical derived PDA for `account`     |

### Events

| Event                    | Fields                                                                       | Emitted                                                    |
|--------------------------|--------------------------------------------------------------------------------|-------------------------------------------------------------|
| `AccountPartiallyFrozen` | `mint: Pubkey`, `account: Pubkey`, `frozen_balance: u64`, `operator: Pubkey` | Once per entry, after the partial side is set/updated |

---

## Instruction: `unfreeze_account_partial` (Management)

No parameters.

Lifts the partial freeze: resets the account's `AccountCompliance.frozen_balance` to 0; an existing full freeze keeps applying. The record is never closed. Fails with `AccountNotPartiallyFrozen` if there is no partial freeze (including when there is no record).

### Preconditions

- `require_role` (`ROLE_FREEZE_MANAGER`), `require_not_paused`, `require_active`
- `require_functionality(FREEZE_REMOVE_PARTIAL_FREEZE)` — the mint's asset-class version must be finalized and have the `FREEZE_REMOVE_PARTIAL_FREEZE` functionality bit enabled.

### Accounts

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                                                  |
|---------------------------|-----|--------|----------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; pays for the `AccountCompliance` record when `set_freeze` creates it |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                                                 |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`                                  |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                                           |
| `account`                 | no  | no     | UncheckedAccount                 | The token account whose partial freeze is removed; used only as a seed                                                                                 |
| `mint_compliance_pda` | no | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; `deactivated` must be 0 (checked by `require_active`) |
| `account_compliance_pda` | yes | no | UncheckedAccount | seeds `["account_compliance", mint, account]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; read by `common::freeze_status` (may be absent), created/written by the `set_freeze` CPI |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`                            |
| `registry_writer` | no | no | UncheckedAccount | seeds `["registry_writer"]` (this program); signs the `set_freeze` CPI |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID`; target of the CPI |
| `system_program` | no | no | Program<System> | Required by `set_freeze` (`init_if_needed` on the record) |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountPartialFreezeRemoved` |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI                                                                  |

### Events

| Event                         | Fields                                                | Emitted                                          |
|-------------------------------|-------------------------------------------------------|--------------------------------------------------|
| `AccountPartialFreezeRemoved` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After the partial side is cleared |

---

## Instruction: `batch_unfreeze_account_partial` (Management)

Removes the partial freeze, in a single instruction, from every account passed in via `remaining_accounts` — the batched equivalent of calling `unfreeze_account_partial` once per account. Runs the same authorization checks as `unfreeze_account_partial` (freeze-manager role, not paused, active, functionality) and emits one `AccountPartialFreezeRemoved` event per account. An existing full freeze on the entry is kept. Each entry is a `(account, account_compliance_pda)` pair in `remaining_accounts`: the PDA is checked against the derived address, read with `common::freeze_status`, and written with one `set_freeze` CPI per entry (the hook's `init_if_needed` creates the record on first use and tolerates a target a griefer pre-funded with lamports).

### Parameters

No instruction parameters — the accounts are described entirely by `remaining_accounts`.

### Remaining accounts

Two accounts per entry, in order, appended as `remaining_accounts`:

| Offset (per entry `i`) | Account              | Mut | Notes                                                                                                        |
|------------------------|----------------------|-----|-----------------------------------------------------------------------------------------------------------------|
| `i * 2`                | `account`            | no  | The token account whose partial freeze is removed; used only as a seed                                          |
| `i * 2 + 1` | `account_compliance_pda` | yes | Must equal the canonical `["account_compliance", mint, account]` PDA of `transfer-hook` — verified on-chain; may be absent (created by `set_freeze` when a side is set) |

### Preconditions

- `!remaining_accounts.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() % 2 == 0` — errors `InvalidRemainingAccounts` otherwise (exactly one `account_compliance_pda` per `account`).
- `require_role(ROLE_FREEZE_MANAGER)` — the `authority` caller must sign and hold `ROLE_FREEZE_MANAGER` on this mint.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_REMOVE_PARTIAL_FREEZE)` — the mint's asset-class version must be finalized and enable removing partial freezes (same functionality bit as `unfreeze_account_partial`; batching doesn't get its own bit).
- Per entry: the supplied `account_compliance_pda` must match the address `Pubkey::find_program_address(["account_compliance", mint, account], TRANSFER_HOOK_PROGRAM_ID)` derives, else `AccountCompliancePdaMismatch`.
- Per entry: the partial side must be set (an absent record counts as clear), else `AccountNotPartiallyFrozen`.

### Accounts

The fixed accounts (the per-entry accounts are passed via `remaining_accounts`, see above). Note there is no `account` or `account_compliance_pda` field here — both are supplied per entry instead.

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                       |
|---------------------------|-----|--------|----------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; pays for the `AccountCompliance` record when `set_freeze` creates it |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                      |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`       |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                |
| `mint_compliance_pda` | no | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; `deactivated` must be 0 (checked by `require_active`) |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `registry_writer` | no | no | UncheckedAccount | seeds `["registry_writer"]` (this program); signs the `set_freeze` CPI |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID`; target of the CPI |
| `system_program` | no | no | Program<System> | Required by `set_freeze` (`init_if_needed` on the record) |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]`                                                           |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID                                                               |

### Errors

| Code                        | Cause                                                                                |
|-----------------------------|---------------------------------------------------------------------------------------|
| `EmptyBatch`                | `remaining_accounts` is empty                                                          |
| `InvalidRemainingAccounts`  | `remaining_accounts.len() % 2 != 0`                                                    |
| `AccountCompliancePdaMismatch`    | Supplied `account_compliance_pda` does not match the canonical derived PDA for `account`     |
| `AccountNotPartiallyFrozen` | The entry's partial side is clear (or it has no record)                  |

### Events

| Event                         | Fields                                                | Emitted                                                     |
|-------------------------------|-----------------------------------------------------------|------------------------------------------------------------|
| `AccountPartialFreezeRemoved` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After each entry's partial side is cleared |

---

## Emitting events

The management instructions emit their events with `emit_cpi!` (not `emit!`), which records each event as a self-CPI captured in the transaction's `innerInstructions` rather than in program logs — avoiding log-truncation loss for off-chain indexers. This requires `#[event_cpi]` on the corresponding accounts struct (injecting the `event_authority` and `program` accounts listed above) and the `event-cpi` feature on `anchor-lang` in `Cargo.toml`. Because these events live in inner instructions, Anchor's log-based `program.addEventListener` cannot see them; the test suite decodes them from `innerInstructions` instead (see `tests/program_helpers/event_helper.ts`).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.

No program CPIs into `freeze`, and no program depends on this crate for reads: `transfer-hook` and `hold` read the freeze state through `common::freeze_status` / `common::require_locked_balance_covered`. `freeze` depends on `transfer-hook` (with `cpi`) for the `set_freeze` CPI; the hook does not depend on `freeze`, so there is no cycle.
