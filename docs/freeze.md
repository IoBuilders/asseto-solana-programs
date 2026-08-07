# freeze — Program Reference

Program ID: `8L1kqDvAYC9dQXNNNnZbABtRbHGjzoxSgAPzbQZmwmSd`

Controls all programmatic freezing. Freezing is expressed purely as marker PDAs owned by this program — no Token-2022 account state is ever changed, and no instruction here signs a Token-2022 CPI. This program owns no Token-2022 authority: mints are deployed with their freeze authority set to `None`, irreversibly (see [deploy.md](deploy.md)), so a token-level freeze is not available to it.

Exposes one category of instructions:
- **Management** (`freeze_account`, `batch_freeze_account`, `unfreeze_account`, `batch_unfreeze_account`, `freeze_account_partial`, `batch_freeze_account_partial`, `unfreeze_account_partial`, `batch_unfreeze_account_partial`): called directly by an account holding `ROLE_FREEZE_MANAGER` to enforce account-level restrictions. Each emits an event via `emit_cpi!` (see [Emitting events](#emitting-events)).

Enforcement is entirely read-side: `transfer-hook::execute` reads these marker PDAs through the verification functions below and aborts the transfer. A frozen account is therefore still `Initialized` (not `Frozen`) as far as Token-2022 is concerned.

Also exports four verification functions; `require_unfrozen_account` and `require_locked_balance_covered` are the pair the transfer hook links in.

---

## State

### `FrozenAccountStatus`

```rust
#[account]
pub struct FrozenAccountStatus {
    pub bump: u8,
}
// LEN = 8 (discriminator) + 1 (bump) = 9 bytes
// Seeds: ["frozen_account", mint, account]
```

Marker PDA. Exists if and only if the account has been frozen at the management level by `freeze_account`. Its mere existence blocks transfers out of the account (checked by `require_unfrozen_account` in `transfer-hook::execute`).

### `FrozenBalance`

```rust
#[account]
pub struct FrozenBalance {
    pub balance: u64,
    pub bump: u8,
}
// LEN = 8 (discriminator) + 8 (balance) + 1 (bump) = 17 bytes
// Seeds: ["frozen_balance", mint, account]
```

Records the amount of tokens locked in a partial freeze. Created or updated by `freeze_account_partial`. `require_frozen_balance_covered` in `transfer-hook::execute` reads this to enforce that the balance left after the transfer still covers the locked amount.

---

## Error Codes

```rust
pub enum ErrorCode {
    Unauthorized,                 // calling_authority not in the allowed set
    AccountFrozen,                // frozen_account_pda exists
    InsufficientUnfrozenBalance,  // available balance < requested transfer amount
}
```

---

## Exported Verification Functions

These functions gate transfers. They are called by `transfer-hook::execute`
(which runs the compliance suite on every `transfer_checked`) and by any other
program that needs the same checks.

### `require_unfrozen_account`

```rust
pub fn require_unfrozen_account(frozen_account_pda: &AccountInfo) -> Result<()>
```

Returns `Err(ErrorCode::AccountFrozen)` if the `frozen_account_pda` account exists (has non-empty data). Pass as `&AccountInfo` with seeds `["frozen_account", mint, account]`, `seeds::program = FREEZE_PROGRAM_ID`.

### `require_unfrozen_balance`

```rust
pub fn require_unfrozen_balance(
    amount: u64,
    token_account: &AccountInfo,
    frozen_balance_pda: &AccountInfo,
) -> Result<()>
```

Reads the current token balance from `token_account` and the frozen balance from `frozen_balance_pda`. Computes `available = account_balance.saturating_sub(frozen_balance)` and returns `Err(ErrorCode::InsufficientUnfrozenBalance)` if `available < amount`. If `frozen_balance_pda` is empty (no partial freeze), frozen balance is treated as zero. This is the **pre-debit** form (balance read before the transfer moves tokens).

### `require_frozen_balance_covered`

```rust
pub fn require_frozen_balance_covered(
    token_account: &AccountInfo,
    frozen_balance_pda: &AccountInfo,
) -> Result<()>
```

**Post-debit** variant of `require_unfrozen_balance`. Token-2022 invokes the hook *after* moving tokens, so the source is already debited. The pre-debit invariant `balance_pre - frozen >= amount` is algebraically `balance_post >= frozen`, so this compares the (post-debit) balance directly against the locked amount and needs no `amount` argument. Returns `Err(ErrorCode::InsufficientUnfrozenBalance)` if `account_balance < frozen_balance`. For a batch the hook fires once per leg after that leg's debit, so checking `balance_post >= frozen` at every leg keeps the cumulative movement within the lock.

Thin wrapper over `require_locked_balance_covered` with `additional_locked = 0`.

### `require_locked_balance_covered`

```rust
pub fn require_locked_balance_covered(
    token_account: &AccountInfo,
    frozen_balance_pda: &AccountInfo,
    additional_locked: u64,
) -> Result<()>
```

`require_frozen_balance_covered` widened to liens this program does not own: asserts `balance >= frozen + additional_locked`, returning `Err(ErrorCode::InsufficientUnfrozenBalance)` on a shortfall or on overflow of the sum.

`additional_locked` is a plain `u64` rather than a second account to read, so `freeze` needs no dependency on whichever program owns the other lien. Today the only such lien is `hold`'s `held_amount`, which `transfer-hook::execute` reads via `hold::held_amount` and passes in — see [`docs/hold.md`](hold.md). This is the function the hook actually calls.

---

## Instruction: `freeze_account` (Management)

No parameters.

Creates the `frozen_account_pda` marker. After this call `require_unfrozen_account` will reject any transfer attempt on this account.

### Preconditions

- `require_role` — signer must hold `ROLE_FREEZE_MANAGER`.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_FREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and have the `FREEZE_FREEZE_ACCOUNT` functionality bit enabled.

### Accounts

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                                    |
|---------------------------|-----|--------|----------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; funds the PDA creation                                                                                  |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                                   |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`                    |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                             |
| `account`                 | no  | no     | UncheckedAccount                 | The token account to freeze; used only as a seed                                                                                         |
| `deactivate_pda`          | no  | no     | UncheckedAccount                 | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`                                                                   |
| `frozen_account_pda`      | yes | no     | `Account<FrozenAccountStatus>`   | init, `payer = authority`; seeds `["frozen_account", mint, account]`                                                                     |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`              |
| `system_program`          | no  | no     | Program<System>                  |                                                                                                                                          |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountFrozen` |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI                                                    |

### Events

| Event           | Fields                                                | Emitted                                          |
|-----------------|-------------------------------------------------------|--------------------------------------------------|
| `AccountFrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After the `frozen_account_pda` marker is created |

---

## Instruction: `batch_freeze_account` (Management)

Freezes, in a single instruction, every account passed in via `remaining_accounts` — the batched equivalent of calling `freeze_account` once per account. Runs the same authorization checks as `freeze_account` (freeze-manager role, not paused, active, functionality) and emits one `AccountFrozen` event per account. Unlike the singular instruction, there is no per-account `frozen_account_pda` field in the typed accounts struct — Anchor's `init` constraint can't create a variable number of accounts, so each `frozen_account_pda` is created manually inside the handler via `common::pda_utils::create_or_adopt_pda` (signed by the PDA's own seeds), followed by a manual discriminator + Borsh write. `create_or_adopt_pda` tolerates a target PDA that a griefer pre-funded with lamports before the transaction landed — see [`docs/common.md`](common.md#function-create_or_adopt_pda).

### Parameters

No instruction parameters — the accounts to freeze are described entirely by `remaining_accounts`.

### Remaining accounts

Two accounts per entry, in order, appended as `remaining_accounts`:

| Offset (per entry `i`) | Account              | Mut | Notes                                                                                                                 |
|------------------------|----------------------|-----|-----------------------------------------------------------------------------------------------------------------------|
| `i * 2`                | `account`            | no  | The token account to freeze; used only as a seed                                                                      |
| `i * 2 + 1`            | `frozen_account_pda` | yes | Not yet created; must equal the canonical `["frozen_account", mint, account]` PDA — verified on-chain before creation |

### Preconditions

- `!remaining_accounts.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() % 2 == 0` — errors `InvalidRemainingAccounts` otherwise (exactly one `frozen_account_pda` per `account`).
- `require_role(ROLE_FREEZE_MANAGER)` — the `authority` caller must sign and hold `ROLE_FREEZE_MANAGER` on this mint.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_FREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and enable freezing (same functionality bit as `freeze_account`; batching doesn't get its own bit).
- Per entry: the supplied `frozen_account_pda` must match the address `Pubkey::find_program_address(["frozen_account", mint, account], freeze_program_id)` derives, else `FrozenAccountPdaMismatch`.
- Per entry: `frozen_account_pda` must not already exist, else `AccountFrozen` (mirrors `freeze_account`'s behaviour of failing on an already-frozen account, since Anchor's `init` would likewise fail with the account already in use).

### Accounts

The fixed accounts (the per-entry accounts are passed via `remaining_accounts`, see above). Note there is no `account` or `frozen_account_pda` field here — both are supplied per entry instead.

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                       |
|---------------------------|-----|--------|----------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; funds every `frozen_account_pda` creation                                                  |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                      |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`       |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                |
| `deactivate_pda`          | no  | no     | UncheckedAccount                 | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`                                                      |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `system_program`          | no  | no     | Program<System>                  | Target of the `create_or_adopt_pda` CPI(s) per entry                                                                       |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]`                                                           |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID                                                               |

### Errors

| Code                       | Cause                                                                                |
|----------------------------|--------------------------------------------------------------------------------------|
| `EmptyBatch`               | `remaining_accounts` is empty                                                        |
| `InvalidRemainingAccounts` | `remaining_accounts.len() % 2 != 0`                                                  |
| `FrozenAccountPdaMismatch` | Supplied `frozen_account_pda` does not match the canonical derived PDA for `account` |
| `AccountFrozen`            | `frozen_account_pda` already exists (account is already frozen)                      |

### Events

| Event           | Fields                                                | Emitted                                                   |
|-----------------|-------------------------------------------------------|-----------------------------------------------------------|
| `AccountFrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After each entry's `frozen_account_pda` marker is created |

---

## Instruction: `unfreeze_account` (Management)

No parameters.

Closes the `frozen_account_pda` marker and returns rent to `authority`.

### Preconditions

- `require_role` (`ROLE_FREEZE_MANAGER`), `require_not_paused`, `require_active`
- `require_functionality(FREEZE_UNFREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and have the `FREEZE_UNFREEZE_ACCOUNT` functionality bit enabled.

### Accounts

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                                      |
|---------------------------|-----|--------|----------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; receives the closed PDA's lamports                                                                        |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                                     |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`                      |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                               |
| `account`                 | no  | no     | UncheckedAccount                 | The token account to unfreeze; used only as a seed                                                                                         |
| `deactivate_pda`          | no  | no     | UncheckedAccount                 | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`                                                                     |
| `frozen_account_pda`      | yes | no     | `Account<FrozenAccountStatus>`   | `close = authority`; seeds `["frozen_account", mint, account]`                                                                             |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`                |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountUnfrozen` |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI                                                      |

### Events

| Event             | Fields                                                | Emitted                                          |
|-------------------|-------------------------------------------------------|--------------------------------------------------|
| `AccountUnfrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | Before the `frozen_account_pda` marker is closed |

---

## Instruction: `batch_unfreeze_account` (Management)

Unfreezes, in a single instruction, every account passed in via `remaining_accounts` — the batched equivalent of calling `unfreeze_account` once per account. Runs the same authorization checks as `unfreeze_account` (freeze-manager role, not paused, active, functionality) and emits one `AccountUnfrozen` event per account. Unlike the singular instruction, there is no per-account `frozen_account_pda` field in the typed accounts struct — Anchor's `close` constraint can't target a variable number of accounts, so each `frozen_account_pda` is closed manually inside the handler via `common::pda_utils::close_pda` (zeroing lamports and data, returning rent to `authority`) — see [`docs/common.md`](common.md#function-close_pda).

### Parameters

No instruction parameters — the accounts to unfreeze are described entirely by `remaining_accounts`.

### Remaining accounts

Two accounts per entry, in order, appended as `remaining_accounts`:

| Offset (per entry `i`) | Account              | Mut | Notes                                                                                                     |
|------------------------|----------------------|-----|-------------------------------------------------------------------------------------------------------------|
| `i * 2`                | `account`            | no  | The token account to unfreeze; used only as a seed                                                          |
| `i * 2 + 1`            | `frozen_account_pda` | yes | Must equal the canonical `["frozen_account", mint, account]` PDA — verified on-chain; must already exist |

### Preconditions

- `!remaining_accounts.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() % 2 == 0` — errors `InvalidRemainingAccounts` otherwise (exactly one `frozen_account_pda` per `account`).
- `require_role(ROLE_FREEZE_MANAGER)` — the `authority` caller must sign and hold `ROLE_FREEZE_MANAGER` on this mint.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_UNFREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and enable unfreezing (same functionality bit as `unfreeze_account`; batching doesn't get its own bit).
- Per entry: the supplied `frozen_account_pda` must match the address `Pubkey::find_program_address(["frozen_account", mint, account], freeze_program_id)` derives, else `FrozenAccountPdaMismatch`.
- Per entry: `frozen_account_pda` must already exist, else `AccountNotFrozen` (mirrors `unfreeze_account`'s behaviour of failing when the typed account can't be resolved).

### Accounts

The fixed accounts (the per-entry accounts are passed via `remaining_accounts`, see above). Note there is no `account` or `frozen_account_pda` field here — both are supplied per entry instead.

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                       |
|---------------------------|-----|--------|----------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; receives every closed `frozen_account_pda`'s lamports                                     |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                      |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`       |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                |
| `deactivate_pda`          | no  | no     | UncheckedAccount                 | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`                                                      |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]`                                                           |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID                                                               |

### Errors

| Code                       | Cause                                                                              |
|----------------------------|----------------------------------------------------------------------------------------|
| `EmptyBatch`               | `remaining_accounts` is empty                                                          |
| `InvalidRemainingAccounts` | `remaining_accounts.len() % 2 != 0`                                                    |
| `FrozenAccountPdaMismatch` | Supplied `frozen_account_pda` does not match the canonical derived PDA for `account`   |
| `AccountNotFrozen`         | `frozen_account_pda` does not exist (account is not frozen)                            |

### Events

| Event             | Fields                                                | Emitted                                                 |
|-------------------|---------------------------------------------------------|------------------------------------------------------------|
| `AccountUnfrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | Before each entry's `frozen_account_pda` marker is closed |

---

## Instruction: `freeze_account_partial` (Management)

### Parameters

```rust
balance: u64  // amount to lock (must not exceed actual token balance)
```

Creates the `frozen_balance_pda` on first call; overwrites `balance` on subsequent calls (`init_if_needed`). After this call `require_unfrozen_balance` will prevent transfers that would reduce the unfrozen portion below zero.

### Preconditions

- `require_role` (`ROLE_FREEZE_MANAGER`), `require_not_paused`, `require_active`
- `require_functionality(FREEZE_PARTIALLY_FREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and have the `FREEZE_PARTIALLY_FREEZE_ACCOUNT` functionality bit enabled.

### Accounts

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                                             |
|---------------------------|-----|--------|----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; funds PDA creation if needed                                                                                     |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                                            |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`                             |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                                      |
| `account`                 | no  | no     | UncheckedAccount                 | The token account to partially freeze; used only as a seed                                                                                        |
| `deactivate_pda`          | no  | no     | UncheckedAccount                 | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`                                                                            |
| `frozen_balance_pda`      | yes | no     | `Account<FrozenBalance>`         | `init_if_needed`, `payer = authority`; seeds `["frozen_balance", mint, account]`                                                                  |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`                       |
| `system_program`          | no  | no     | Program<System>                  |                                                                                                                                                   |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountPartiallyFrozen` |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI                                                             |

### Events

| Event                    | Fields                                                                       | Emitted                                                                                        |
|--------------------------|------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| `AccountPartiallyFrozen` | `mint: Pubkey`, `account: Pubkey`, `frozen_balance: u64`, `operator: Pubkey` | After the `frozen_balance_pda` is set/updated (`frozen_balance` is the newly-locked `balance`) |

---

## Instruction: `batch_freeze_account_partial` (Management)

Partially freezes, in a single instruction, every account passed in via `remaining_accounts`, locking `balances[i]` for the `i`-th account — the batched equivalent of calling `freeze_account_partial` once per account. Runs the same authorization checks as `freeze_account_partial` (freeze-manager role, not paused, active, functionality) and emits one `AccountPartiallyFrozen` event per account. Like the singular instruction, a `frozen_balance_pda` that already exists has its balance overwritten rather than rejected. Unlike the singular instruction, there is no per-account `frozen_balance_pda` field in the typed accounts struct — Anchor's `init_if_needed` constraint can't target a variable number of accounts, so each `frozen_balance_pda` is created manually on first use via `common::pda_utils::create_or_adopt_pda` (signed by the PDA's own seeds), which tolerates a target pre-funded by a griefer — see [`docs/common.md`](common.md#function-create_or_adopt_pda).

### Parameters

```rust
balances: Vec<u64>  // amount to lock per account; balances[i] applies to the i-th account
```

### Remaining accounts

Two accounts per entry, in order, appended as `remaining_accounts`:

| Offset (per entry `i`) | Account              | Mut | Notes                                                                                                                |
|------------------------|----------------------|-----|-----------------------------------------------------------------------------------------------------------------------|
| `i * 2`                | `account`            | no  | The token account to partially freeze; used only as a seed                                                            |
| `i * 2 + 1`            | `frozen_balance_pda` | yes | Must equal the canonical `["frozen_balance", mint, account]` PDA — verified on-chain; may already exist (overwritten) |

### Preconditions

- `!balances.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() == balances.len() * 2` — errors `InvalidRemainingAccounts` otherwise (exactly one `frozen_balance_pda` per balance).
- `require_role(ROLE_FREEZE_MANAGER)` — the `authority` caller must sign and hold `ROLE_FREEZE_MANAGER` on this mint.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_PARTIALLY_FREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and enable partial freezing (same functionality bit as `freeze_account_partial`; batching doesn't get its own bit).
- Per entry: the supplied `frozen_balance_pda` must match the address `Pubkey::find_program_address(["frozen_balance", mint, account], freeze_program_id)` derives, else `FrozenBalancePdaMismatch`.

### Accounts

The fixed accounts (the per-entry accounts are passed via `remaining_accounts`, see above). Note there is no `account` or `frozen_balance_pda` field here — both are supplied per entry instead.

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                       |
|---------------------------|-----|--------|----------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; funds every `frozen_balance_pda` creation                                                  |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                      |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`       |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                |
| `deactivate_pda`          | no  | no     | UncheckedAccount                 | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`                                                      |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `system_program`          | no  | no     | Program<System>                  | Target of the `create_or_adopt_pda` CPI(s) per entry                                                                       |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]`                                                           |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID                                                               |

### Errors

| Code                       | Cause                                                                               |
|----------------------------|---------------------------------------------------------------------------------------|
| `EmptyBatch`               | `balances` is empty                                                                   |
| `InvalidRemainingAccounts` | `remaining_accounts.len() != balances.len() * 2`                                       |
| `FrozenBalancePdaMismatch` | Supplied `frozen_balance_pda` does not match the canonical derived PDA for `account`   |

### Events

| Event                    | Fields                                                                       | Emitted                                                    |
|--------------------------|--------------------------------------------------------------------------------|-------------------------------------------------------------|
| `AccountPartiallyFrozen` | `mint: Pubkey`, `account: Pubkey`, `frozen_balance: u64`, `operator: Pubkey` | Once per entry, after the `frozen_balance_pda` is set/updated |

---

## Instruction: `unfreeze_account_partial` (Management)

No parameters.

Closes the `frozen_balance_pda` marker and returns rent to `authority`, lifting the partial freeze so `require_unfrozen_balance` no longer restricts transfers from the account.

### Preconditions

- `require_role` (`ROLE_FREEZE_MANAGER`), `require_not_paused`, `require_active`
- `require_functionality(FREEZE_REMOVE_PARTIAL_FREEZE)` — the mint's asset-class version must be finalized and have the `FREEZE_REMOVE_PARTIAL_FREEZE` functionality bit enabled.

### Accounts

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                                                  |
|---------------------------|-----|--------|----------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; receives the closed PDA's lamports                                                                                    |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                                                 |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`                                  |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                                           |
| `account`                 | no  | no     | UncheckedAccount                 | The token account whose partial freeze is removed; used only as a seed                                                                                 |
| `deactivate_pda`          | no  | no     | UncheckedAccount                 | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`                                                                                 |
| `frozen_balance_pda`      | yes | no     | `Account<FrozenBalance>`         | `close = authority`; seeds `["frozen_balance", mint, account]`                                                                                         |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`                            |
| `system_program`          | no  | no     | Program<System>                  |                                                                                                                                                        |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountPartialFreezeRemoved` |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI                                                                  |

### Events

| Event                         | Fields                                                | Emitted                                          |
|-------------------------------|-------------------------------------------------------|--------------------------------------------------|
| `AccountPartialFreezeRemoved` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | Before the `frozen_balance_pda` marker is closed |

---

## Instruction: `batch_unfreeze_account_partial` (Management)

Removes the partial freeze, in a single instruction, from every account passed in via `remaining_accounts` — the batched equivalent of calling `unfreeze_account_partial` once per account. Runs the same authorization checks as `unfreeze_account_partial` (freeze-manager role, not paused, active, functionality) and emits one `AccountPartialFreezeRemoved` event per account. Unlike the singular instruction, there is no per-account `frozen_balance_pda` field in the typed accounts struct — Anchor's `close` constraint can't target a variable number of accounts, so each `frozen_balance_pda` is closed manually inside the handler via `common::pda_utils::close_pda`.

### Parameters

No instruction parameters — the accounts are described entirely by `remaining_accounts`.

### Remaining accounts

Two accounts per entry, in order, appended as `remaining_accounts`:

| Offset (per entry `i`) | Account              | Mut | Notes                                                                                                        |
|------------------------|----------------------|-----|-----------------------------------------------------------------------------------------------------------------|
| `i * 2`                | `account`            | no  | The token account whose partial freeze is removed; used only as a seed                                          |
| `i * 2 + 1`            | `frozen_balance_pda` | yes | Must equal the canonical `["frozen_balance", mint, account]` PDA — verified on-chain; must already exist |

### Preconditions

- `!remaining_accounts.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() % 2 == 0` — errors `InvalidRemainingAccounts` otherwise (exactly one `frozen_balance_pda` per `account`).
- `require_role(ROLE_FREEZE_MANAGER)` — the `authority` caller must sign and hold `ROLE_FREEZE_MANAGER` on this mint.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_REMOVE_PARTIAL_FREEZE)` — the mint's asset-class version must be finalized and enable removing partial freezes (same functionality bit as `unfreeze_account_partial`; batching doesn't get its own bit).
- Per entry: the supplied `frozen_balance_pda` must match the address `Pubkey::find_program_address(["frozen_balance", mint, account], freeze_program_id)` derives, else `FrozenBalancePdaMismatch`.
- Per entry: `frozen_balance_pda` must already exist, else `AccountNotPartiallyFrozen` (mirrors `unfreeze_account_partial`'s behaviour of failing when the typed account can't be resolved).

### Accounts

The fixed accounts (the per-entry accounts are passed via `remaining_accounts`, see above). Note there is no `account` or `frozen_balance_pda` field here — both are supplied per entry instead.

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                       |
|---------------------------|-----|--------|----------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; receives every closed `frozen_balance_pda`'s lamports                                     |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                      |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`       |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                |
| `deactivate_pda`          | no  | no     | UncheckedAccount                 | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`                                                      |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]`                                                           |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID                                                               |

### Errors

| Code                        | Cause                                                                                |
|-----------------------------|---------------------------------------------------------------------------------------|
| `EmptyBatch`                | `remaining_accounts` is empty                                                          |
| `InvalidRemainingAccounts`  | `remaining_accounts.len() % 2 != 0`                                                    |
| `FrozenBalancePdaMismatch`  | Supplied `frozen_balance_pda` does not match the canonical derived PDA for `account`   |
| `AccountNotPartiallyFrozen` | `frozen_balance_pda` does not exist (account is not partially frozen)                  |

### Events

| Event                         | Fields                                                | Emitted                                                     |
|-------------------------------|-----------------------------------------------------------|------------------------------------------------------------|
| `AccountPartialFreezeRemoved` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | Before each entry's `frozen_balance_pda` marker is closed |

---

## Emitting events

The management instructions emit their events with `emit_cpi!` (not `emit!`), which records each event as a self-CPI captured in the transaction's `innerInstructions` rather than in program logs — avoiding log-truncation loss for off-chain indexers. This requires `#[event_cpi]` on the corresponding accounts struct (injecting the `event_authority` and `program` accounts listed above) and the `event-cpi` feature on `anchor-lang` in `Cargo.toml`. Because these events live in inner instructions, Anchor's log-based `program.addEventListener` cannot see them; the test suite decodes them from `innerInstructions` instead (see `tests/program_helpers/event_helper.ts`).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.

No program CPIs into `freeze`. Only `transfer` depends on this crate, and only to link the two verification functions above — plain function calls, not CPI. `mint` and `operations` have no `freeze` dependency in their `Cargo.toml`.
