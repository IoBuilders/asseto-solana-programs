# transfer-control — Program Reference

Program ID: `3h92PdZJB7TuCzp6iPDtrJm2k8V7fn5ETYNwCYiYy9Eo`

Governs who may transfer tokens for a given mint. One mode is currently supported:

| Mode | Effect |
|---|---|
| **Whitelist** | Both source and destination must be individually whitelisted before a transfer is allowed |

If no mode is set (no `transfer_control_mode_pda` created), transfers are unrestricted.

Also exports `verify_transfer_control_mode`, a helper function used by `mint` and `transfer` to enforce the active mode against one or more whitelist PDAs.

---

## State: `TransferControlMode`

```rust
#[account]
#[derive(InitSpace)]
pub struct TransferControlMode {
    pub mode: TransferMode,
    pub bump: u8,
}

pub enum TransferMode { Whitelist }

// Seeds: ["transfer_control_mode", mint]
```

---

## Error Codes

```rust
pub enum TransferControlError {
    NotWhitelisted,  // whitelist mode is active and a whitelist_pda passed to verify_transfer_control_mode is empty
}
```

---

## Exported Function

### `verify_transfer_control_mode`

```rust
pub fn verify_transfer_control_mode(
    transfer_control_mode_pda: &AccountInfo,
    whitelist_pdas: &[&AccountInfo],
) -> Result<()>
```

`transfer_control_mode_pda` and every `whitelist_pda` are raw, unchecked PDAs — their address is verified by the caller's `seeds`/`bump` constraints, but Anchor does not deserialize their contents. Behaviour:

- If `transfer_control_mode_pda` has empty data, no mode is active — returns `Ok(())` immediately.
- Otherwise, Borsh-deserializes `TransferControlMode` from the account data (via `try_deserialize`, which also checks the discriminator).
- If `mode == TransferMode::Whitelist`, every account in `whitelist_pdas` is checked with `data_is_empty()`; an empty account (not whitelisted) errors with `TransferControlError::NotWhitelisted`.

Called by `mint::mint` (with the single `destination_whitelist_pda`) and `transfer::verify_transfer` (with both `source_whitelist_pda` and `destination_whitelist_pda`).

---

## Instruction: `initialize` (Management)

### Parameters

```rust
mode: TransferMode
```

Creates `transfer_control_mode_pda` (`init`, fixed space) and writes `mode` into it. Unlike a resizable/closable design, this instruction only creates the PDA — there is currently no instruction to close it or change the mode afterward.

### Preconditions

- `require_role(ROLE_CONTROL_LIST)` — the `authority` caller must sign and hold `ROLE_CONTROL_LIST` on this mint (checked against its own `["roles", mint, authority]` PDA).
- `require_not_paused`, `require_active`
- `require_functionality(TRANSFER_CONTROL_INITIALIZE)` — the mint's asset-class version must be finalized and have the `TRANSFER_CONTROL_INITIALIZE` functionality bit enabled.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | yes | yes | Signer | Must hold `ROLE_CONTROL_LIST`; funds PDA creation |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| `transfer_control_mode_pda` | yes | no | `Account<TransferControlMode>` | `init`, `payer = authority`; seeds `["transfer_control_mode", mint]` |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `system_program` | no | no | Program<System> | |
| `event_authority` | no | no | UncheckedAccount | Added by `#[event_cpi]`; seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`; this program's own id |

Calling `initialize` a second time for the same mint fails at the System program level ("already in use"), since the account struct uses `init` rather than `init_if_needed`.

---

## Instruction: `add_to_whitelist` (Management)

No parameters.

Creates a `whitelist_pda` marker for a specific token account. If the PDA already exists, the instruction is a no-op.

### Preconditions

- `require_role(ROLE_CONTROL_LIST)` — the `authority` caller must sign and hold `ROLE_CONTROL_LIST` on this mint.
- `require_not_paused`, `require_active`
- `require_functionality(TRANSFER_CONTROL_ADD_TO_WHITELIST)` — the mint's asset-class version must be finalized and have the `TRANSFER_CONTROL_ADD_TO_WHITELIST` functionality bit enabled.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | yes | yes | Signer | Must hold `ROLE_CONTROL_LIST`; funds PDA creation |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `account` | no | no | UncheckedAccount | Token account to whitelist; used as a seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| `whitelist_pda` | yes | no | Account | `init_if_needed`; seeds `["whitelist", mint, account]`, `payer = authority` |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `system_program` | no | no | Program<System> | |
| `event_authority` | no | no | UncheckedAccount | Added by `#[event_cpi]`; seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`; this program's own id |

---

## Instruction: `remove_from_whitelist` (Management)

No parameters.

Closes the `whitelist_pda` and returns rent to `authority`. If the PDA does not exist, the instruction is a no-op.

### Preconditions

- `require_role(ROLE_CONTROL_LIST)` — the `authority` caller must sign and hold `ROLE_CONTROL_LIST` on this mint.
- `require_not_paused`, `require_active`
- `require_functionality(TRANSFER_CONTROL_REMOVE_FROM_WHITELIST)` — the mint's asset-class version must be finalized and have the `TRANSFER_CONTROL_REMOVE_FROM_WHITELIST` functionality bit enabled.

### Accounts

Same shape as `add_to_whitelist` but the `whitelist_pda` constraint uses `close = authority`.

---

## Events

Each instruction emits an event via `emit_cpi!` (requires the `event-cpi` feature on `anchor-lang`
and the `event_authority` / `program` accounts above on the instruction context).

### `TransferControlModeSet`

Emitted at the end of `initialize`, after the `transfer_control_mode_pda` has been created.

```rust
#[event]
pub struct TransferControlModeSet {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub mode: TransferMode,
}
```

### `AccountWhitelisted`

Emitted at the end of `add_to_whitelist`, including on the no-op path where the `whitelist_pda`
already existed.

```rust
#[event]
pub struct AccountWhitelisted {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub operator: Pubkey,
}
```

### `AccountRemovedFromWhitelist`

Emitted at the end of `remove_from_whitelist`, after the `whitelist_pda` close has been queued.

```rust
#[event]
pub struct AccountRemovedFromWhitelist {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub operator: Pubkey,
}
```

`operator` is the `authority` that signed the instruction in all three events (must hold `ROLE_CONTROL_LIST`).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
