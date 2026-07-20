# freeze — Program Reference

Program ID: `8L1kqDvAYC9dQXNNNnZbABtRbHGjzoxSgAPzbQZmwmSd`

Controls the Token-2022 freeze authority and all programmatic freezing. Owns the `["freeze_authority", mint]` PDA set as the mint's freeze authority during `deploy_mint`.

Exposes two categories of instructions:
- **Auxiliary** (`block_account`, `unblock_account`): called exclusively via CPI by `mint`, `operations`, and `transfer` as part of their token operation flows. These do not emit events.
- **Management** (`freeze_account`, `unfreeze_account`, `partially_freeze_account`, `remove_partial_freeze`): called directly by an account holding `ROLE_FREEZE_MANAGER` to enforce account-level restrictions. Each emits an event via `emit_cpi!` (see [Emitting events](#emitting-events)).

Also exports two verification functions used by `transfer` to gate transfers.

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

Marker PDA. Exists if and only if the account has been frozen at the management level by `freeze_account`. Its mere existence blocks transfers out of the account (checked by `require_unfrozen_account` in `transfer`).

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

Records the amount of tokens locked in a partial freeze. Created or updated by `partially_freeze_account`. `require_unfrozen_balance` in `transfer` reads this to enforce that the unfrozen balance covers the transfer amount.

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

These functions are called by `transfer` (and any future operational program) to gate transfers.

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

Reads the current token balance from `token_account` and the frozen balance from `frozen_balance_pda`. Computes `available = account_balance.saturating_sub(frozen_balance)` and returns `Err(ErrorCode::InsufficientUnfrozenBalance)` if `available < amount`. If `frozen_balance_pda` is empty (no partial freeze), frozen balance is treated as zero.

---

## Instruction: `block_account` (Auxiliary)

No parameters.

### Authorization

The `calling_authority` must be one of three allowed PDAs (verified by key comparison at runtime):
- `["mint_authority", mint]` owned by `mint`
- `["permanent_delegate", mint]` owned by `operations`
- `["transfer", mint]` owned by `transfer`

No external wallet can produce these signatures. Only the owning program can via `invoke_signed`.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `calling_authority` | no | yes | Signer | One of the three allowed PDAs (runtime check) |
| `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]` (owned by this program) |
| `mint` | no | no | UncheckedAccount | The Token-2022 mint |
| `token_account` | yes | no | UncheckedAccount | Token account to block (freeze) |
| `token_2022_program` | no | no | Program<Token2022> | |

### Execution

`invoke_signed` → `freeze_account(token_account, mint, freeze_authority)` signed with seeds `["freeze_authority", mint, bump]`.

---

## Instruction: `unblock_account` (Auxiliary)

No parameters. Same accounts and authorization model as `block_account`.

### Execution

`invoke_signed` → `thaw_account(token_account, mint, freeze_authority)` signed with seeds `["freeze_authority", mint, bump]`.

---

## Instruction: `freeze_account` (Management)

No parameters.

Creates the `frozen_account_pda` marker. After this call `require_unfrozen_account` will reject any transfer attempt on this account.

### Preconditions

- `require_role` — signer must hold `ROLE_FREEZE_MANAGER`.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | yes | yes | Signer | Must hold `ROLE_FREEZE_MANAGER`; funds the PDA creation |
| `authority_roles_pda` | no | no | AccountLoader<Roles> | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `mint_owner_pda` | no | no | Account<MintOwner> | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `account` | no | no | UncheckedAccount | The token account to freeze; used only as a seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| `frozen_account_pda` | yes | no | `Account<FrozenAccountStatus>` | init, `payer = authority`; seeds `["frozen_account", mint, account]` |
| `system_program` | no | no | Program<System> | |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountFrozen` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI |

### Events

| Event | Fields | Emitted |
|---|---|---|
| `AccountFrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | After the `frozen_account_pda` marker is created |

---

## Instruction: `unfreeze_account` (Management)

No parameters.

Closes the `frozen_account_pda` marker and returns rent to `authority`.

### Preconditions

- `require_role` (`ROLE_FREEZE_MANAGER`), `require_not_paused`, `require_active`

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | yes | yes | Signer | Must hold `ROLE_FREEZE_MANAGER`; receives the closed PDA's lamports |
| `authority_roles_pda` | no | no | AccountLoader<Roles> | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `mint_owner_pda` | no | no | Account<MintOwner> | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `account` | no | no | UncheckedAccount | The token account to unfreeze; used only as a seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| `frozen_account_pda` | yes | no | `Account<FrozenAccountStatus>` | `close = authority`; seeds `["frozen_account", mint, account]` |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountUnfrozen` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI |

### Events

| Event | Fields | Emitted |
|---|---|---|
| `AccountUnfrozen` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | Before the `frozen_account_pda` marker is closed |

---

## Instruction: `partially_freeze_account` (Management)

### Parameters

```rust
balance: u64  // amount to lock (must not exceed actual token balance)
```

Creates the `frozen_balance_pda` on first call; overwrites `balance` on subsequent calls (`init_if_needed`). After this call `require_unfrozen_balance` will prevent transfers that would reduce the unfrozen portion below zero.

### Preconditions

- `require_role` (`ROLE_FREEZE_MANAGER`), `require_not_paused`, `require_active`

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | yes | yes | Signer | Must hold `ROLE_FREEZE_MANAGER`; funds PDA creation if needed |
| `authority_roles_pda` | no | no | AccountLoader<Roles> | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `mint_owner_pda` | no | no | Account<MintOwner> | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `account` | no | no | UncheckedAccount | The token account to partially freeze; used only as a seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| `frozen_balance_pda` | yes | no | `Account<FrozenBalance>` | `init_if_needed`, `payer = authority`; seeds `["frozen_balance", mint, account]` |
| `system_program` | no | no | Program<System> | |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountPartiallyFrozen` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI |

### Events

| Event | Fields | Emitted |
|---|---|---|
| `AccountPartiallyFrozen` | `mint: Pubkey`, `account: Pubkey`, `frozen_balance: u64`, `operator: Pubkey` | After the `frozen_balance_pda` is set/updated (`frozen_balance` is the newly-locked `balance`) |

---

## Instruction: `remove_partial_freeze` (Management)

No parameters.

Closes the `frozen_balance_pda` marker and returns rent to `authority`, lifting the partial freeze so `require_unfrozen_balance` no longer restricts transfers from the account.

### Preconditions

- `require_role` (`ROLE_FREEZE_MANAGER`), `require_not_paused`, `require_active`

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | yes | yes | Signer | Must hold `ROLE_FREEZE_MANAGER`; receives the closed PDA's lamports |
| `authority_roles_pda` | no | no | AccountLoader<Roles> | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `mint_owner_pda` | no | no | Account<MintOwner> | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `account` | no | no | UncheckedAccount | The token account whose partial freeze is removed; used only as a seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| `frozen_balance_pda` | yes | no | `Account<FrozenBalance>` | `close = authority`; seeds `["frozen_balance", mint, account]` |
| `system_program` | no | no | Program<System> | |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `AccountPartialFreezeRemoved` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI |

### Events

| Event | Fields | Emitted |
|---|---|---|
| `AccountPartialFreezeRemoved` | `mint: Pubkey`, `account: Pubkey`, `operator: Pubkey` | Before the `frozen_balance_pda` marker is closed |

---

## Emitting events

The four management instructions emit their events with `emit_cpi!` (not `emit!`), which records each event as a self-CPI captured in the transaction's `innerInstructions` rather than in program logs — avoiding log-truncation loss for off-chain indexers. This requires `#[event_cpi]` on the corresponding accounts struct (injecting the `event_authority` and `program` accounts listed above) and the `event-cpi` feature on `anchor-lang` in `Cargo.toml`. Because these events live in inner instructions, Anchor's log-based `program.addEventListener` cannot see them; the test suite decodes them from `innerInstructions` instead (see `tests/program_helpers/event_helper.ts`). The auxiliary `block_account` / `unblock_account` instructions do not emit events.

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file, and via `use common::program_ids::{MINT_PROGRAM_ID, OPERATIONS_PROGRAM_ID, TRANSFER_PROGRAM_ID};` in `lib.rs` where the `assert_authorized_caller` function uses them directly. There is no per-program `constants.rs`.

`mint`, `operations`, and `transfer` all depend on `freeze` for CPI calls — the circular dependency that previously required hardcoding IDs is resolved by sourcing them all from `common::program_ids` instead.
