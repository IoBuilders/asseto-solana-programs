# freeze — Program Reference

Program ID: `8L1kqDvAYC9dQXNNNnZbABtRbHGjzoxSgAPzbQZmwmSd`

Controls all programmatic freezing. Freezing is expressed purely as one `freeze_state` PDA per `(mint, token account)`, owned by this program — no Token-2022 account state is ever changed, and no instruction here signs a Token-2022 CPI. This program owns no Token-2022 authority: mints are deployed with their freeze authority set to `None`, irreversibly (see [deploy.md](deploy.md)), so a token-level freeze is not available to it.

Exposes one category of instructions:
- **Management** (`freeze_account`, `batch_freeze_account`, `unfreeze_account`, `batch_unfreeze_account`, `freeze_account_partial`, `batch_freeze_account_partial`, `unfreeze_account_partial`, `batch_unfreeze_account_partial`): called directly by an account holding `ROLE_FREEZE_MANAGER` to enforce account-level restrictions. Each emits an event via `emit_cpi!` (see [Emitting events](#emitting-events)).

Enforcement is entirely read-side: `transfer-hook::execute` reads the `freeze_state` PDA through the verification functions below and aborts the transfer. A frozen account is therefore still `Initialized` (not `Frozen`) as far as Token-2022 is concerned.

Also exports six verification/reader functions; `freeze_status` and `require_locked_balance_covered` are the pair the transfer hook links in.

---

## State

### `FreezeState`

```rust
#[account]
pub struct FreezeState {
    pub fully_frozen: bool,   // full freeze (set by freeze_account)
    pub frozen_balance: u64,  // partial freeze: amount locked; 0 = no partial freeze
    pub bump: u8,
}
// LEN = 8 (discriminator) + 1 + 8 + 1 = 18 bytes
// Seeds: ["freeze_state", mint, account]
```

Holds **both** freeze sides of a token account. They used to live in two PDAs (`FrozenAccountStatus` at `["frozen_account", …]` and `FrozenBalance` at `["frozen_balance", …]`); merging them frees one slot in the transfer hook's `ExtraAccountMetaList`, which is capped by Token-2022's 32 KiB heap (see [`transfer-hook.md`](transfer-hook.md#metalist-contents)).

The two sides stay **independent**: no instruction checks the other side's state, and clearing one side never touches the other. The account is created by whichever side is set first and **closed only once both sides are clear** (rent returned to the authority that clears the last side). An absent account means "nothing frozen".

The partial side is just `frozen_balance > 0` (`FreezeState::is_partially_frozen`). That works because a partial freeze of 0 is **rejected** with `InvalidFreezeAmount`, matching the EVM implementation (ATS `checkNonZeroFreezeAmount` → `IFreeze.InvalidFreezeAmount`). Before the merge, a 0 partial freeze was accepted and created a removable `FrozenBalance` holding 0; it locked nothing, so rejecting it removes a no-op rather than a capability.

State matrix (∅ = no account; F = full; P = partial):

| From \ op | `freeze_account` | `unfreeze_account` | `freeze_account_partial(b)` | `unfreeze_account_partial` |
|---|---|---|---|---|
| ∅ | F (creates) | `AccountNotInitialized` | P(b) (creates) | `AccountNotInitialized` |
| F | `AccountFrozen` | ∅ (closes) | F+P(b) | `AccountNotPartiallyFrozen` |
| P | F+P | `AccountNotFrozen` | P(b′) (overwrites) | ∅ (closes) |
| F+P | `AccountFrozen` | **P (stays open)** | F+P(b′) | **F (stays open)** |

`b` is always > 0: `freeze_account_partial(0)` fails with `InvalidFreezeAmount` from any state and changes nothing.

The batch variants follow the same matrix per entry, except that an absent account surfaces as `AccountNotFrozen` / `AccountNotPartiallyFrozen` instead of `AccountNotInitialized`.

---

## Error Codes

```rust
pub enum ErrorCode {
    Unauthorized,                 // unused
    AccountFrozen,                // full-freeze side already set / source is fully frozen
    InsufficientUnfrozenBalance,  // locked amount no longer covered by the balance
    EmptyBatch,                   // batch with no entries
    InvalidRemainingAccounts,     // remaining accounts not paired with the entries
    FreezeStatePdaMismatch,       // batch entry's freeze_state_pda is not the derived one
    AccountNotFrozen,             // unfreeze on an account whose full-freeze side is clear
    AccountNotPartiallyFrozen,    // partial unfreeze on an account whose partial side is clear
    InvalidFreezeAmount,          // partial freeze of 0
}
```

---

## Exported Verification Functions

These functions gate transfers. They are called by `transfer-hook::execute`
(which runs the compliance suite on every `transfer_checked`) and by any other
program that needs the same checks. Every one that reads state takes the
`freeze_state_pda` (seeds `["freeze_state", mint, account]`, `seeds::program = FREEZE_PROGRAM_ID`);
the caller is responsible for validating those seeds.

### `freeze_status`

```rust
pub struct FreezeStatus { pub fully_frozen: bool, pub frozen_balance: u64 }

pub fn freeze_status(freeze_state_pda: &AccountInfo) -> Result<FreezeStatus>
```

Reads both sides in one go. An empty `freeze_state_pda` yields `FreezeStatus::default()` (not frozen, 0 locked); otherwise the account is loaded with `Account::<FreezeState>::try_from`, so a foreign owner or a wrong discriminator errors instead of being trusted. `frozen_balance` is 0 when there is no partial freeze. This is what `transfer-hook::execute`, `hold::execute_hold` and `hold`'s creation paths call, so each reads the PDA once.

### `require_unfrozen_account`

```rust
pub fn require_unfrozen_account(freeze_state_pda: &AccountInfo) -> Result<()>
```

Returns `Err(ErrorCode::AccountFrozen)` if the full-freeze side of `freeze_state_pda` is set.

### `require_unfrozen_balance`

```rust
pub fn require_unfrozen_balance(
    amount: u64,
    token_account: &AccountInfo,
    freeze_state_pda: &AccountInfo,
) -> Result<()>
```

Reads the current token balance from `token_account` and the partially frozen balance from `freeze_state_pda`. Computes `available = account_balance.saturating_sub(frozen_balance)` and returns `Err(ErrorCode::InsufficientUnfrozenBalance)` if `available < amount`. With no partial freeze, frozen balance is treated as zero. This is the **pre-debit** form (balance read before the transfer moves tokens).

### `frozen_balance`

```rust
pub fn frozen_balance(freeze_state_pda: &AccountInfo) -> Result<u64>
```

Reads the amount locked by a partial freeze off `freeze_state_pda`, returning 0 when there is no partial freeze (absent PDA, or only the full-freeze side set) rather than erroring. This is the reader a caller uses to build the `total_locked` sum it passes to `require_locked_balance_covered` below.

### `require_frozen_balance_covered`

```rust
pub fn require_frozen_balance_covered(
    token_account: &AccountInfo,
    freeze_state_pda: &AccountInfo,
) -> Result<()>
```

**Post-debit** variant of `require_unfrozen_balance`. Token-2022 invokes the hook *after* moving tokens, so the source is already debited. The pre-debit invariant `balance_pre - frozen >= amount` is algebraically `balance_post >= frozen`, so this compares the (post-debit) balance directly against the locked amount and needs no `amount` argument. Returns `Err(ErrorCode::InsufficientUnfrozenBalance)` if `account_balance < frozen_balance`. For a batch the hook fires once per leg after that leg's debit, so checking `balance_post >= frozen` at every leg keeps the cumulative movement within the lock.

Thin wrapper: reads `frozen_balance(freeze_state_pda)` and passes it straight to `require_locked_balance_covered`. Kept for a caller that only cares about the partial-freeze lien and has no other lien to add in; nothing in this workspace currently calls it, since every real caller also has a hold lien to fold in (see below).

### `require_locked_balance_covered`

```rust
pub fn require_locked_balance_covered(
    token_account: &AccountInfo,
    total_locked: u64,
) -> Result<()>
```

Asserts `balance >= total_locked`. This function owns no lien itself and reads no PDA — it is a pure comparator, so `total_locked` must already be the caller's own sum of every lien on the account (partial-freeze balance plus any lien owned by another program). That is what lets `freeze` stay free of a dependency on whichever program owns the other lien: today that is `hold`'s `held_amount`, which `transfer-hook::execute` and `hold::execute_hold` each read via `freeze::freeze_status` + `common::held_amount`, sum, and pass in — see [`docs/hold.md`](hold.md). This is the function the hook actually calls.

---

## Instruction: `freeze_account` (Management)

No parameters.

Sets the full-freeze side of the account's `freeze_state_pda`, creating the PDA if the account has no freeze yet (`init_if_needed`); an existing partial freeze is kept untouched. After this call the transfer hook rejects any transfer out of this account. Fails with `AccountFrozen` if the full-freeze side is already set (explicit check — with the merged account the PDA may legitimately exist already, so Anchor's `init` "already in use" error no longer applies).

### Preconditions

- `require_role` — signer must hold `ROLE_FREEZE_MANAGER`.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_FREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and have the `FREEZE_FREEZE_ACCOUNT` functionality bit enabled.

### Accounts

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                                    |
|---------------------------|-----|--------|----------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; funds the PDA creation if needed                                                                        |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                                   |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`                    |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                             |
| `account`                 | no  | no     | UncheckedAccount                 | The token account to freeze; used only as a seed                                                                                         |
| `deactivate_pda`          | no  | no     | UncheckedAccount                 | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`                                                                   |
| `freeze_state_pda`        | yes | no     | `Account<FreezeState>`           | `init_if_needed`, `payer = authority`; seeds `["freeze_state", mint, account]`                                                           |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`              |
| `system_program`          | no  | no     | Program<System>                  |                                                                                                                                          |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountFrozen` |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI                                                    |

### Events

| Event           | Fields                                                | Emitted                                          |
|-----------------|-------------------------------------------------------|--------------------------------------------------|
| `AccountFrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After the full-freeze side is set |

---

## Instruction: `batch_freeze_account` (Management)

Freezes, in a single instruction, every account passed in via `remaining_accounts` — the batched equivalent of calling `freeze_account` once per account. Runs the same authorization checks as `freeze_account` (freeze-manager role, not paused, active, functionality) and emits one `AccountFrozen` event per account. Unlike the singular instruction, there is no per-account `freeze_state_pda` field in the typed accounts struct — Anchor's `init_if_needed` constraint can't target a variable number of accounts, so each `freeze_state_pda` is loaded (via `Account::try_from`) if it exists, or created manually inside the handler via `common::pda_utils::create_or_adopt_pda` (signed by the PDA's own seeds), and then written back with a manual discriminator + Borsh write. An existing partial freeze on the entry is kept. `create_or_adopt_pda` tolerates a target PDA that a griefer pre-funded with lamports before the transaction landed — see [`docs/common.md`](common.md#function-create_or_adopt_pda).

### Parameters

No instruction parameters — the accounts to freeze are described entirely by `remaining_accounts`.

### Remaining accounts

Two accounts per entry, in order, appended as `remaining_accounts`:

| Offset (per entry `i`) | Account              | Mut | Notes                                                                                                                 |
|------------------------|----------------------|-----|-----------------------------------------------------------------------------------------------------------------------|
| `i * 2`                | `account`            | no  | The token account to freeze; used only as a seed                                                                      |
| `i * 2 + 1`            | `freeze_state_pda`   | yes | Must equal the canonical `["freeze_state", mint, account]` PDA — verified on-chain; created if absent                |

### Preconditions

- `!remaining_accounts.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() % 2 == 0` — errors `InvalidRemainingAccounts` otherwise (exactly one `freeze_state_pda` per `account`).
- `require_role(ROLE_FREEZE_MANAGER)` — the `authority` caller must sign and hold `ROLE_FREEZE_MANAGER` on this mint.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_FREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and enable freezing (same functionality bit as `freeze_account`; batching doesn't get its own bit).
- Per entry: the supplied `freeze_state_pda` must match the address `Pubkey::find_program_address(["freeze_state", mint, account], freeze_program_id)` derives, else `FreezeStatePdaMismatch`.
- Per entry: the full-freeze side must not already be set, else `AccountFrozen` (mirrors `freeze_account`).

### Accounts

The fixed accounts (the per-entry accounts are passed via `remaining_accounts`, see above). Note there is no `account` or `freeze_state_pda` field here — both are supplied per entry instead.

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                       |
|---------------------------|-----|--------|----------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; funds every `freeze_state_pda` creation                                                    |
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
| `FreezeStatePdaMismatch`   | Supplied `freeze_state_pda` does not match the canonical derived PDA for `account`   |
| `AccountFrozen`            | The entry's full-freeze side is already set                                          |

### Events

| Event           | Fields                                                | Emitted                                                   |
|-----------------|-------------------------------------------------------|-----------------------------------------------------------|
| `AccountFrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After each entry's full-freeze side is set |

---

## Instruction: `unfreeze_account` (Management)

No parameters.

Clears the full-freeze side of the account's `freeze_state_pda`. If the account has no partial freeze, the PDA is then empty and is closed, returning its rent to `authority`; otherwise it stays open so the partial freeze keeps applying. Fails with `AccountNotInitialized` if the PDA does not exist, and with `AccountNotFrozen` if it exists but only carries a partial freeze.

### Preconditions

- `require_role` (`ROLE_FREEZE_MANAGER`), `require_not_paused`, `require_active`
- `require_functionality(FREEZE_UNFREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and have the `FREEZE_UNFREEZE_ACCOUNT` functionality bit enabled.

### Accounts

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                                      |
|---------------------------|-----|--------|----------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; receives the PDA's lamports if it is closed                                                               |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                                     |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`                      |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                               |
| `account`                 | no  | no     | UncheckedAccount                 | The token account to unfreeze; used only as a seed                                                                                         |
| `deactivate_pda`          | no  | no     | UncheckedAccount                 | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`                                                                     |
| `freeze_state_pda`        | yes | no     | `Account<FreezeState>`           | seeds `["freeze_state", mint, account]`; closed to `authority` in the handler when both sides are clear                                   |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`                |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountUnfrozen` |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI                                                      |

### Events

| Event             | Fields                                                | Emitted                                          |
|-------------------|-------------------------------------------------------|--------------------------------------------------|
| `AccountUnfrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After the full-freeze side is cleared |

---

## Instruction: `batch_unfreeze_account` (Management)

Unfreezes, in a single instruction, every account passed in via `remaining_accounts` — the batched equivalent of calling `unfreeze_account` once per account. Runs the same authorization checks as `unfreeze_account` (freeze-manager role, not paused, active, functionality) and emits one `AccountUnfrozen` event per account. Unlike the singular instruction, there is no per-account `freeze_state_pda` field in the typed accounts struct, so each entry's `freeze_state_pda` is loaded via `Account::try_from` and either written back (partial freeze still active) or, once both sides are clear, closed manually via `common::pda_utils::close_pda` (zeroing lamports and data, returning rent to `authority`) — see [`docs/common.md`](common.md#function-close_pda).

### Parameters

No instruction parameters — the accounts to unfreeze are described entirely by `remaining_accounts`.

### Remaining accounts

Two accounts per entry, in order, appended as `remaining_accounts`:

| Offset (per entry `i`) | Account              | Mut | Notes                                                                                                     |
|------------------------|----------------------|-----|-------------------------------------------------------------------------------------------------------------|
| `i * 2`                | `account`            | no  | The token account to unfreeze; used only as a seed                                                          |
| `i * 2 + 1`            | `freeze_state_pda`   | yes | Must equal the canonical `["freeze_state", mint, account]` PDA — verified on-chain; must already exist |

### Preconditions

- `!remaining_accounts.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() % 2 == 0` — errors `InvalidRemainingAccounts` otherwise (exactly one `freeze_state_pda` per `account`).
- `require_role(ROLE_FREEZE_MANAGER)` — the `authority` caller must sign and hold `ROLE_FREEZE_MANAGER` on this mint.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_UNFREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and enable unfreezing (same functionality bit as `unfreeze_account`; batching doesn't get its own bit).
- Per entry: the supplied `freeze_state_pda` must match the address `Pubkey::find_program_address(["freeze_state", mint, account], freeze_program_id)` derives, else `FreezeStatePdaMismatch`.
- Per entry: `freeze_state_pda` must exist with its full-freeze side set, else `AccountNotFrozen`.

### Accounts

The fixed accounts (the per-entry accounts are passed via `remaining_accounts`, see above). Note there is no `account` or `freeze_state_pda` field here — both are supplied per entry instead.

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                       |
|---------------------------|-----|--------|----------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; receives the lamports of every `freeze_state_pda` it closes                              |
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
| `FreezeStatePdaMismatch`   | Supplied `freeze_state_pda` does not match the canonical derived PDA for `account`     |
| `AccountNotFrozen`         | The entry's `freeze_state_pda` is absent or its full-freeze side is clear              |

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

Locks `balance` tokens of the account: sets the partial side of its `freeze_state_pda`, creating the PDA if the account has no freeze yet (`init_if_needed`), and overwrites the locked amount on subsequent calls. An existing full freeze is kept untouched. After this call the transfer hook rejects transfers that would leave less than the locked amount in the account. `balance` must be > 0, else `InvalidFreezeAmount` (as in EVM); lifting a partial freeze is `unfreeze_account_partial`'s job.

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
| `freeze_state_pda`        | yes | no     | `Account<FreezeState>`           | `init_if_needed`, `payer = authority`; seeds `["freeze_state", mint, account]`                                                                    |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`                       |
| `system_program`          | no  | no     | Program<System>                  |                                                                                                                                                   |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountPartiallyFrozen` |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI                                                             |

### Events

| Event                    | Fields                                                                       | Emitted                                                                                        |
|--------------------------|------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| `AccountPartiallyFrozen` | `mint: Pubkey`, `account: Pubkey`, `frozen_balance: u64`, `operator: Pubkey` | After the partial side is set/updated (`frozen_balance` is the newly-locked `balance`) |

---

## Instruction: `batch_freeze_account_partial` (Management)

Partially freezes, in a single instruction, every account passed in via `remaining_accounts`, locking `balances[i]` for the `i`-th account — the batched equivalent of calling `freeze_account_partial` once per account. Runs the same authorization checks as `freeze_account_partial` (freeze-manager role, not paused, active, functionality) and emits one `AccountPartiallyFrozen` event per account. Like the singular instruction, an existing partial freeze has its balance overwritten rather than rejected, and an existing full freeze is kept. Unlike the singular instruction, there is no per-account `freeze_state_pda` field in the typed accounts struct — Anchor's `init_if_needed` constraint can't target a variable number of accounts, so each `freeze_state_pda` is created manually on first use via `common::pda_utils::create_or_adopt_pda` (signed by the PDA's own seeds), which tolerates a target pre-funded by a griefer — see [`docs/common.md`](common.md#function-create_or_adopt_pda).

### Parameters

```rust
balances: Vec<u64>  // amount to lock per account; balances[i] applies to the i-th account
```

### Remaining accounts

Two accounts per entry, in order, appended as `remaining_accounts`:

| Offset (per entry `i`) | Account              | Mut | Notes                                                                                                                |
|------------------------|----------------------|-----|-----------------------------------------------------------------------------------------------------------------------|
| `i * 2`                | `account`            | no  | The token account to partially freeze; used only as a seed                                                            |
| `i * 2 + 1`            | `freeze_state_pda`   | yes | Must equal the canonical `["freeze_state", mint, account]` PDA — verified on-chain; created if absent, partial side overwritten |

### Preconditions

- `!balances.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() == balances.len() * 2` — errors `InvalidRemainingAccounts` otherwise (exactly one `freeze_state_pda` per balance).
- `require_role(ROLE_FREEZE_MANAGER)` — the `authority` caller must sign and hold `ROLE_FREEZE_MANAGER` on this mint.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_PARTIALLY_FREEZE_ACCOUNT)` — the mint's asset-class version must be finalized and enable partial freezing (same functionality bit as `freeze_account_partial`; batching doesn't get its own bit).
- Every `balances[i]` must be > 0, else `InvalidFreezeAmount` (checked up front, before any entry is written).
- Per entry: the supplied `freeze_state_pda` must match the address `Pubkey::find_program_address(["freeze_state", mint, account], freeze_program_id)` derives, else `FreezeStatePdaMismatch`.

### Accounts

The fixed accounts (the per-entry accounts are passed via `remaining_accounts`, see above). Note there is no `account` or `freeze_state_pda` field here — both are supplied per entry instead.

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                       |
|---------------------------|-----|--------|----------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; funds every `freeze_state_pda` creation                                                    |
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
| `InvalidFreezeAmount`      | Some `balances[i]` is 0                                                                 |
| `FreezeStatePdaMismatch`   | Supplied `freeze_state_pda` does not match the canonical derived PDA for `account`     |

### Events

| Event                    | Fields                                                                       | Emitted                                                    |
|--------------------------|--------------------------------------------------------------------------------|-------------------------------------------------------------|
| `AccountPartiallyFrozen` | `mint: Pubkey`, `account: Pubkey`, `frozen_balance: u64`, `operator: Pubkey` | Once per entry, after the partial side is set/updated |

---

## Instruction: `unfreeze_account_partial` (Management)

No parameters.

Lifts the partial freeze: resets the locked amount of the account's `freeze_state_pda` to 0. If the account is not fully frozen, the PDA is then empty and is closed, returning its rent to `authority`; otherwise it stays open so the full freeze keeps applying. Fails with `AccountNotInitialized` if the PDA does not exist, and with `AccountNotPartiallyFrozen` if it exists but only carries a full freeze.

### Preconditions

- `require_role` (`ROLE_FREEZE_MANAGER`), `require_not_paused`, `require_active`
- `require_functionality(FREEZE_REMOVE_PARTIAL_FREEZE)` — the mint's asset-class version must be finalized and have the `FREEZE_REMOVE_PARTIAL_FREEZE` functionality bit enabled.

### Accounts

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                                                  |
|---------------------------|-----|--------|----------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; receives the PDA's lamports if it is closed                                                                           |
| `authority_roles_pda`     | no  | no     | AccountLoader<Roles>             | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`                                                 |
| `asset_configuration_pda` | no  | no     | Account<AssetConfiguration>      | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda`                                  |
| `mint`                    | no  | no     | UncheckedAccount                 | Read by `require_not_paused`                                                                                                                           |
| `account`                 | no  | no     | UncheckedAccount                 | The token account whose partial freeze is removed; used only as a seed                                                                                 |
| `deactivate_pda`          | no  | no     | UncheckedAccount                 | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`                                                                                 |
| `freeze_state_pda`        | yes | no     | `Account<FreezeState>`           | seeds `["freeze_state", mint, account]`; closed to `authority` in the handler when both sides are clear                                               |
| `asset_class_version_pda` | no  | no     | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`                            |
| `system_program`          | no  | no     | Program<System>                  |                                                                                                                                                        |
| `event_authority`         | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountPartialFreezeRemoved` |
| `program`                 | no  | no     | UncheckedAccount                 | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI                                                                  |

### Events

| Event                         | Fields                                                | Emitted                                          |
|-------------------------------|-------------------------------------------------------|--------------------------------------------------|
| `AccountPartialFreezeRemoved` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After the partial side is cleared |

---

## Instruction: `batch_unfreeze_account_partial` (Management)

Removes the partial freeze, in a single instruction, from every account passed in via `remaining_accounts` — the batched equivalent of calling `unfreeze_account_partial` once per account. Runs the same authorization checks as `unfreeze_account_partial` (freeze-manager role, not paused, active, functionality) and emits one `AccountPartialFreezeRemoved` event per account. Unlike the singular instruction, there is no per-account `freeze_state_pda` field in the typed accounts struct, so each entry's `freeze_state_pda` is loaded via `Account::try_from` and either written back (full freeze still active) or, once both sides are clear, closed manually via `common::pda_utils::close_pda`.

### Parameters

No instruction parameters — the accounts are described entirely by `remaining_accounts`.

### Remaining accounts

Two accounts per entry, in order, appended as `remaining_accounts`:

| Offset (per entry `i`) | Account              | Mut | Notes                                                                                                        |
|------------------------|----------------------|-----|-----------------------------------------------------------------------------------------------------------------|
| `i * 2`                | `account`            | no  | The token account whose partial freeze is removed; used only as a seed                                          |
| `i * 2 + 1`            | `freeze_state_pda`   | yes | Must equal the canonical `["freeze_state", mint, account]` PDA — verified on-chain; must already exist |

### Preconditions

- `!remaining_accounts.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() % 2 == 0` — errors `InvalidRemainingAccounts` otherwise (exactly one `freeze_state_pda` per `account`).
- `require_role(ROLE_FREEZE_MANAGER)` — the `authority` caller must sign and hold `ROLE_FREEZE_MANAGER` on this mint.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.
- `require_functionality(FREEZE_REMOVE_PARTIAL_FREEZE)` — the mint's asset-class version must be finalized and enable removing partial freezes (same functionality bit as `unfreeze_account_partial`; batching doesn't get its own bit).
- Per entry: the supplied `freeze_state_pda` must match the address `Pubkey::find_program_address(["freeze_state", mint, account], freeze_program_id)` derives, else `FreezeStatePdaMismatch`.
- Per entry: `freeze_state_pda` must exist with its partial side set, else `AccountNotPartiallyFrozen`.

### Accounts

The fixed accounts (the per-entry accounts are passed via `remaining_accounts`, see above). Note there is no `account` or `freeze_state_pda` field here — both are supplied per entry instead.

| Account                   | Mut | Signer | Type                             | Notes                                                                                                                       |
|---------------------------|-----|--------|----------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `authority`               | yes | yes    | Signer                           | Must hold `ROLE_FREEZE_MANAGER`; receives the lamports of every `freeze_state_pda` it closes                              |
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
| `FreezeStatePdaMismatch`    | Supplied `freeze_state_pda` does not match the canonical derived PDA for `account`     |
| `AccountNotPartiallyFrozen` | The entry's `freeze_state_pda` is absent or its partial side is clear                  |

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

No program CPIs into `freeze`. `transfer-hook` and `hold` depend on this crate only to link the verification functions above (`freeze_status`, `require_locked_balance_covered`) — plain function calls, not CPI. `transfer` and `operations` only derive the `freeze_state` PDA (via `common::pda_seeds::FREEZE_STATE`) to forward it in the hook block.
