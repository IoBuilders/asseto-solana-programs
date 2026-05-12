# cmtat-freeze — Program Reference

Program ID: `ERyVR64dpCpoEa335A7LfJZnrEUeL7bxgqfqTogXYoAr`

Controls the Token-2022 freeze authority and all CMTAT-level freezing. Owns the `["freeze_authority", mint]` PDA set as the mint's freeze authority during `deploy_mint`.

Exposes two categories of instructions:
- **Auxiliary** (`block_account`, `unblock_account`): called exclusively via CPI by `cmtat-mint`, `cmtat-operations`, and `cmtat-transfer` as part of their token operation flows.
- **Management** (`freeze_account`, `unfreeze_account`, `partially_freeze_account`): called directly by the deployer to enforce CMTAT-level account restrictions.

Also exports two verification functions used by `cmtat-transfer` to gate transfers.

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

Marker PDA. Exists if and only if the account has been frozen at the CMTAT management level by `freeze_account`. Its mere existence blocks transfers out of the account (checked by `require_unfrozen_account` in `cmtat-transfer`).

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

Records the amount of tokens locked in a partial freeze. Created or updated by `partially_freeze_account`. `require_unfrozen_balance` in `cmtat-transfer` reads this to enforce that the unfrozen balance covers the transfer amount.

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

These functions are called by `cmtat-transfer` (and any future operational program) to gate transfers.

### `require_unfrozen_account`

```rust
pub fn require_unfrozen_account(frozen_account_pda: &AccountInfo) -> Result<()>
```

Returns `Err(ErrorCode::AccountFrozen)` if the `frozen_account_pda` account exists (has non-empty data). Pass as `&AccountInfo` with seeds `["frozen_account", mint, account]`, `seeds::program = CMTAT_FREEZE_PROGRAM_ID`.

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
- `["mint_authority", mint]` owned by `cmtat-mint`
- `["permanent_delegate", mint]` owned by `cmtat-operations`
- `["transfer", mint]` owned by `cmtat-transfer`

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

- `verify_deployer` — only the deployer may freeze.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not be deactivated.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | yes | yes | Signer | Funds the PDA creation |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = CMTAT_DEPLOY_PROGRAM_ID` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `account` | no | no | UncheckedAccount | The token account to freeze; used only as a seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = CMTAT_DEACTIVATE_PROGRAM_ID` |
| `frozen_account_pda` | yes | no | `Account<FrozenAccountStatus>` | init; seeds `["frozen_account", mint, account]` |
| `system_program` | no | no | Program<System> | |

---

## Instruction: `unfreeze_account` (Management)

No parameters.

Closes the `frozen_account_pda` marker and returns rent to `deployer`.

### Preconditions

- `verify_deployer`, `require_not_paused`, `require_active`

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | yes | yes | Signer | Receives the closed PDA's lamports |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = CMTAT_DEPLOY_PROGRAM_ID` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `account` | no | no | UncheckedAccount | The token account to unfreeze; used only as a seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = CMTAT_DEACTIVATE_PROGRAM_ID` |
| `frozen_account_pda` | yes | no | `Account<FrozenAccountStatus>` | `close = deployer`; seeds `["frozen_account", mint, account]` |

---

## Instruction: `partially_freeze_account` (Management)

### Parameters

```rust
balance: u64  // amount to lock (must not exceed actual token balance)
```

Creates the `frozen_balance_pda` on first call; overwrites `balance` on subsequent calls (`init_if_needed`). After this call `require_unfrozen_balance` will prevent transfers that would reduce the unfrozen portion below zero.

### Preconditions

- `verify_deployer`, `require_not_paused`, `require_active`

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | yes | yes | Signer | Funds PDA creation if needed |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = CMTAT_DEPLOY_PROGRAM_ID` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `account` | no | no | UncheckedAccount | The token account to partially freeze; used only as a seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = CMTAT_DEACTIVATE_PROGRAM_ID` |
| `frozen_balance_pda` | yes | no | `Account<FrozenBalance>` | `init_if_needed`; seeds `["frozen_balance", mint, account]` |
| `system_program` | no | no | Program<System> | |

---

## Circular Dependency Note

`cmtat-mint`, `cmtat-operations`, and `cmtat-transfer` all depend on `cmtat-freeze` for CPI calls. Therefore `cmtat-freeze` cannot import any of them. All three program IDs are hardcoded in `constants.rs`:

```rust
// All hardcoded — would create circular deps if imported from their crates.
pub const CMTAT_DEPLOY_PROGRAM_ID:     Pubkey = Pubkey::new_from_array([...]);
pub const CMTAT_DEACTIVATE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([...]);
pub const CMTAT_MINT_PROGRAM_ID:       Pubkey = Pubkey::new_from_array([...]);
pub const CMTAT_OPERATIONS_PROGRAM_ID: Pubkey = Pubkey::new_from_array([...]);
pub const CMTAT_TRANSFER_PROGRAM_ID:   Pubkey = Pubkey::new_from_array([...]);
```

Each must be kept in sync manually with the corresponding `declare_id!`.
