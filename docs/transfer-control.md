# transfer-control — Program Reference

Program ID: `3h92PdZJB7TuCzp6iPDtrJm2k8V7fn5ETYNwCYiYy9Eo`

Governs who may transfer tokens for a given mint. One mode is currently supported:

| Mode | Effect |
|---|---|
| **Whitelist** | Both source and destination must be individually in the control list before a transfer is allowed |

If no mode is set (no `transfer_control_mode_pda` created), transfers are unrestricted.

Also exports `verify_transfer_control_mode`, a helper function used by `mint` and `transfer-hook` to enforce the active mode against one or more control-list PDAs.

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
    NotWhitelisted,  // Whitelist mode is active and a control_list_pda passed to verify_transfer_control_mode is empty
    Blacklisted,     // reserved for Blacklist mode (a control_list_pda exists); not raised yet — no Blacklist mode exists
}
```

Each mode fails with its own error, because the failure condition is opposite: Whitelist rejects an account that is *missing* from the control list, Blacklist one that is *present*. `Blacklisted` is appended after `NotWhitelisted` so existing error codes stay stable.

---

## Exported Functions

### `verify_control_list_membership`

```rust
pub fn verify_control_list_membership(control_list_pda: &AccountInfo) -> Result<()>
```

Returns `Ok(())` if `control_list_pda` exists (non-empty data — the account is in the control list), else `Err(TransferControlError::NotWhitelisted)`. This is the mode-blind membership primitive that `verify_transfer_control_mode` applies in Whitelist mode. Callers outside this crate should use `verify_transfer_control_mode` instead, which only treats a missing PDA as a failure when the active mode says so.

### `verify_transfer_control_mode`

```rust
pub fn verify_transfer_control_mode(
    transfer_control_mode_pda: &AccountInfo,
    control_list_pdas: &[&AccountInfo],
) -> Result<()>
```

`transfer_control_mode_pda` and every `control_list_pda` are raw, unchecked PDAs — their address is verified by the caller's `seeds`/`bump` constraints, but Anchor does not deserialize their contents. Behaviour:

- If `transfer_control_mode_pda` has empty data, no mode is active — returns `Ok(())` immediately.
- Otherwise, Borsh-deserializes `TransferControlMode` from the account data (via `Account::<TransferControlMode>::try_from`, which checks the owner is `transfer-control` and the discriminator).
- If `mode == TransferMode::Whitelist`, every account in `control_list_pdas` is checked with `data_is_empty()`; an empty account (not in the control list) errors with `TransferControlError::NotWhitelisted`.

Called by `mint::mint` (with the single `destination_control_list_pda`), `mint::batch_mint` (with every destination's control-list PDA, after re-deriving each with `common::verify_control_list_pda`), `hold::execute_hold` (with both source and destination) and `transfer-hook::execute` (with both `source_control_list_pda` and `destination_control_list_pda`).

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

## Instruction: `add_to_control_list` (Management)

No parameters.

Creates a `control_list_pda` marker for a specific token account. If the PDA already exists, the instruction is a no-op.

### Preconditions

- `require_role(ROLE_CONTROL_LIST)` — the `authority` caller must sign and hold `ROLE_CONTROL_LIST` on this mint.
- `require_not_paused`, `require_active`
- `require_functionality(TRANSFER_CONTROL_ADD_TO_CONTROL_LIST)` — the mint's asset-class version must be finalized and have the `TRANSFER_CONTROL_ADD_TO_CONTROL_LIST` functionality bit enabled.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | yes | yes | Signer | Must hold `ROLE_CONTROL_LIST`; funds PDA creation |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `account` | no | no | UncheckedAccount | Token account to add to the control list; used as a seed |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID` |
| `control_list_pda` | yes | no | Account | `init_if_needed`; seeds `["control_list", mint, account]`, `payer = authority` |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `system_program` | no | no | Program<System> | |
| `event_authority` | no | no | UncheckedAccount | Added by `#[event_cpi]`; seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`; this program's own id |

---

## Instruction: `remove_from_control_list` (Management)

No parameters.

Closes the `control_list_pda` and returns rent to `authority`. If the PDA does not exist, the instruction is a no-op.

### Preconditions

- `require_role(ROLE_CONTROL_LIST)` — the `authority` caller must sign and hold `ROLE_CONTROL_LIST` on this mint.
- `require_not_paused`, `require_active`
- `require_functionality(TRANSFER_CONTROL_REMOVE_FROM_CONTROL_LIST)` — the mint's asset-class version must be finalized and have the `TRANSFER_CONTROL_REMOVE_FROM_CONTROL_LIST` functionality bit enabled.

### Accounts

Same shape as `add_to_control_list` but the `control_list_pda` constraint uses `close = authority`.

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

### `AccountAddedToControlList`

Emitted at the end of `add_to_control_list`, including on the no-op path where the `control_list_pda`
already existed.

```rust
#[event]
pub struct AccountAddedToControlList {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub operator: Pubkey,
}
```

### `AccountRemovedFromControlList`

Emitted at the end of `remove_from_control_list`, after the `control_list_pda` close has been queued.

```rust
#[event]
pub struct AccountRemovedFromControlList {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub operator: Pubkey,
}
```

`operator` is the `authority` that signed the instruction in all three events (must hold `ROLE_CONTROL_LIST`).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
