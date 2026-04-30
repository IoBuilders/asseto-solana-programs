# cmtat-transfer-control — Program Reference

Program ID: `BTLbhoZDCguRqmwhXvQej7pmAqV2TXY3iGdwMPsMBBMw`

Governs who may transfer tokens for a given mint. Two modes are supported:

| Mode | `is_clearing` | Effect |
|---|---|---|
| **Whitelist** | `false` | Both source and destination must be individually whitelisted before a transfer is allowed |
| **Clearing** | `true` | Only the deployer may initiate transfers (acts as a central clearing entity) |

If neither mode is set (no `transfer_control_mode_pda` created), transfers are unrestricted.

Also exports three helper functions used by `cmtat-mint` and `cmtat-transfer` to enforce mode-specific rules.

---

## State: `TransferControlMode`

```rust
#[account]
pub struct TransferControlMode {
    pub is_clearing: bool,
    pub bump: u8,
}
// Seeds: ["transfer_control_mode", mint]
```

---

## Error Codes

```rust
pub enum CmtatTransferControlError {
    NotWhitelisted,  // verify_whitelist called on an absent PDA
}
```

---

## Exported Functions

### `verify_whitelist`

```rust
pub fn verify_whitelist(whitelist_pda: &AccountInfo) -> Result<()>
```

Returns `Ok(())` if the `whitelist_pda` (seeds `["whitelist", mint, account]`) exists (non-empty data). Returns `Err(CmtatTransferControlError::NotWhitelisted)` if absent. Called by `cmtat-mint` and `cmtat-transfer` when whitelist mode is active.

### `is_clearing_activated`

```rust
pub fn is_clearing_activated(transfer_control_mode_pda: &AccountInfo) -> Result<bool>
```

Reads the `TransferControlMode` PDA and returns `is_clearing`. Returns `false` if the PDA does not exist (mode not set).

### `is_whitelist_activated`

```rust
pub fn is_whitelist_activated(transfer_control_mode_pda: &AccountInfo) -> Result<bool>
```

Returns `!is_clearing`. Returns `false` if the PDA does not exist.

---

## Instruction: `set_mode` (Management)

### Parameters

```rust
is_clearing: bool
```

Creates the `transfer_control_mode_pda` on first call; updates `is_clearing` on subsequent calls (`init_if_needed`).

### Preconditions

- `verify_deployer`, `verify_unpause`, `verify_deactivate`

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | yes | yes | Signer | Funds PDA creation if needed |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = CMTAT_DEPLOY_PROGRAM_ID` |
| `mint` | no | no | UncheckedAccount | Read by `verify_unpause` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = CMTAT_DEACTIVATE_PROGRAM_ID` |
| `transfer_control_mode_pda` | yes | no | `Account<TransferControlMode>` | `init_if_needed`; seeds `["transfer_control_mode", mint]` |
| `system_program` | no | no | Program<System> | |

---

## Instruction: `add_to_whitelist` (Management)

No parameters.

Creates a `whitelist_pda` marker for a specific token account. If the PDA already exists, the instruction is a no-op.

### Preconditions

- `verify_deployer`, `verify_unpause`, `verify_deactivate`

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | yes | yes | Signer | Funds PDA creation |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = CMTAT_DEPLOY_PROGRAM_ID` |
| `mint` | no | no | UncheckedAccount | Read by `verify_unpause` |
| `account` | no | no | UncheckedAccount | Token account to whitelist; used as a seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = CMTAT_DEACTIVATE_PROGRAM_ID` |
| `whitelist_pda` | yes | no | Account | `init_if_needed`; seeds `["whitelist", mint, account]` |
| `system_program` | no | no | Program<System> | |

---

## Instruction: `remove_from_whitelist` (Management)

No parameters.

Closes the `whitelist_pda` and returns rent to `deployer`. If the PDA does not exist, the instruction is a no-op.

### Preconditions

- `verify_deployer`, `verify_unpause`, `verify_deactivate`

### Accounts

Same shape as `add_to_whitelist` but the `whitelist_pda` constraint uses `close = deployer`.

---

## constants.rs

```rust
// Sourced from crates.
pub use cmtat_deploy::ID     as CMTAT_DEPLOY_PROGRAM_ID;
pub use cmtat_deactivate::ID as CMTAT_DEACTIVATE_PROGRAM_ID;
```
