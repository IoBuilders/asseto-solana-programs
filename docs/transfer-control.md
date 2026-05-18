# transfer-control — Program Reference

Program ID: `3h92PdZJB7TuCzp6iPDtrJm2k8V7fn5ETYNwCYiYy9Eo`

Governs who may transfer tokens for a given mint. Two modes are supported:

| Mode | Effect |
|---|---|
| **Whitelist** | Both source and destination must be individually whitelisted before a transfer is allowed |
| **Clearing** | The deployer must co-sign every transfer (acts as a central clearing entity) |

If neither mode is set (no `transfer_control_mode_pda` created), transfers are unrestricted.

Also exports two helper functions (`verify_whitelist`, `get_transfer_mode`) used by `mint` and `transfer-hook` to enforce mode-specific rules.

---

## State: `TransferControlMode`

```rust
#[account]
pub struct TransferControlMode {
    pub mode: TransferMode,  // Clearing | Whitelist
    pub bump: u8,
}

pub enum TransferMode { Clearing, Whitelist }

// Seeds: ["transfer_control_mode", mint]
```

---

## Error Codes

```rust
pub enum TransferControlError {
    NotWhitelisted,  // verify_whitelist called on an absent PDA
}
```

---

## Exported Functions

### `verify_whitelist`

```rust
pub fn verify_whitelist(whitelist_pda: &AccountInfo) -> Result<()>
```

Returns `Ok(())` if the `whitelist_pda` (seeds `["whitelist", mint, account]`) exists (non-empty data). Returns `Err(TransferControlError::NotWhitelisted)` if absent. Called by `mint` and `transfer-hook` when whitelist mode is active.

### `get_transfer_mode`

```rust
pub fn get_transfer_mode(transfer_control_mode_pda: &AccountInfo) -> Result<Option<TransferMode>>
```

Single-deserialization mode read. Returns:
- `None` when the PDA does not exist (no controls active).
- `Some(TransferMode::Clearing)` — deployer must co-sign every transfer.
- `Some(TransferMode::Whitelist)` — source and destination must each be whitelisted.

Callers match on the returned `Option<TransferMode>` instead of calling two boolean helpers back-to-back.

---

## Instruction: `set_mode` (Management)

### Parameters

```rust
mode: Option<TransferMode>
```

Writes the mode into `transfer_control_mode_pda` (`init_if_needed`) when `Some`. When `None`, closes the PDA and returns its rent to the deployer — no transfer controls.

### Preconditions

- `verify_deployer`, `require_not_paused`, `require_active`

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | yes | yes | Signer | Funds PDA creation if needed |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| `transfer_control_mode_pda` | yes | no | `Account<TransferControlMode>` | `init_if_needed`; seeds `["transfer_control_mode", mint]` |
| `system_program` | no | no | Program<System> | |

---

## Instruction: `add_to_whitelist` (Management)

No parameters.

Creates a `whitelist_pda` marker for a specific token account. If the PDA already exists, the instruction is a no-op.

### Preconditions

- `verify_deployer`, `require_not_paused`, `require_active`

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | yes | yes | Signer | Funds PDA creation |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `account` | no | no | UncheckedAccount | Token account to whitelist; used as a seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| `whitelist_pda` | yes | no | Account | `init_if_needed`; seeds `["whitelist", mint, account]` |
| `system_program` | no | no | Program<System> | |

---

## Instruction: `remove_from_whitelist` (Management)

No parameters.

Closes the `whitelist_pda` and returns rent to `deployer`. If the PDA does not exist, the instruction is a no-op.

### Preconditions

- `verify_deployer`, `require_not_paused`, `require_active`

### Accounts

Same shape as `add_to_whitelist` but the `whitelist_pda` constraint uses `close = deployer`.

---

## constants.rs

```rust
// Sourced from crates.
pub use deploy::ID     as DEPLOY_PROGRAM_ID;
pub use deactivate::ID as DEACTIVATE_PROGRAM_ID;
```
