# transfer-control — Program Reference

Program ID: `3h92PdZJB7TuCzp6iPDtrJm2k8V7fn5ETYNwCYiYy9Eo`

Governs who may transfer tokens for a given mint. The mode is chosen once, at `initialize`, and cannot be changed afterwards (same as EVM's `ControlList.initializeControlList`):

| Mode | Effect |
|---|---|
| **Whitelist** | Both source and destination must be individually in the control list before a transfer is allowed |
| **Blacklist** | Neither source nor destination may be in the control list; every other account may transfer |

If no mode is set, transfers are unrestricted.

This program holds no state of its own. Both pieces of state live in the transfer hook's compliance registry (ADR option C, see [`transfer-hook.md`](transfer-hook.md#state-compliance-registry)), which is their single source of truth:

| State | Where | Written through |
|---|---|---|
| Transfer mode | `MintCompliance.transfer_mode` (`0` = none, `1` = Whitelist, `2` = Blacklist) | `transfer-hook::set_transfer_mode` |
| Membership of a token account | `AccountCompliance.in_control_list` of `["account_compliance", mint, token_account]` | `transfer-hook::set_in_control_list` |

Each instruction validates, then writes through a CPI signed by this program's `["registry_writer"]` PDA — the only writer the hook accepts for those fields (the same pattern `deactivate` and `freeze` use). Membership is the **flag**, not the existence of a record: an `AccountCompliance` can exist because the account is frozen, and an absent record means "not in the list". The record is never closed.

Enforcement is read-side and lives in `common::verify_transfer_control_mode` (see [`common.md`](common.md#function-verify_transfer_control_mode)), called by `transfer-hook::execute`, `mint::mint`, `mint::batch_mint` and `hold::execute_hold`. None of them depends on this crate.

---

## PDA: `registry_writer`

`["registry_writer"]` (owned by this program, no data). Signs the `set_transfer_mode` and `set_in_control_list` CPIs.

## `TransferMode`

```rust
pub enum TransferMode { Whitelist, Blacklist }  // instruction argument and event field
```

`TransferMode::compliance_value` maps it to the `MintCompliance.transfer_mode` encoding (`TRANSFER_MODE_WHITELIST = 1`, `TRANSFER_MODE_BLACKLIST = 2`; `0` is reserved for "no mode").

---

## Error Codes

```rust
pub enum TransferControlError {
    TransferModeAlreadySet,   // initialize on a mint whose transfer_mode is already set
    AccountNotInControlList,  // remove_from_control_list on an account that is not listed
}
```

The enforcement errors `NotWhitelisted` / `Blacklisted` live in `common::CommonError`, raised by `common::verify_transfer_control_mode`. Each mode fails with its own error because the failure condition is opposite: Whitelist rejects an account that is *missing* from the list, Blacklist one that is *present*.

---

## Instruction: `initialize` (Management)

Sets the mint's transfer mode, once.

### Parameters

```rust
mode: TransferMode   // Whitelist | Blacklist
```

Fails with `TransferModeAlreadySet` if `MintCompliance.transfer_mode` is already set; there is no instruction to change or clear the mode afterwards.

### Preconditions

- `require_role(ROLE_CONTROL_LIST)` — the `authority` caller must sign and hold `ROLE_CONTROL_LIST` on this mint (checked against its own `["roles", mint, authority]` PDA).
- `require_not_paused`, `require_active`
- `require_functionality(TRANSFER_CONTROL_INITIALIZE)` — the mint's asset-class version must be finalized and have the `TRANSFER_CONTROL_INITIALIZE` functionality bit enabled.
- `MintCompliance.transfer_mode == 0`, else `TransferModeAlreadySet`.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | no | yes | Signer | Must hold `ROLE_CONTROL_LIST` |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `mint_compliance_pda` | yes | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; `deactivated` must be 0 (`require_active`), `transfer_mode` must be 0; written by the `set_transfer_mode` CPI |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `registry_writer` | no | no | UncheckedAccount | seeds `["registry_writer"]` (this program); signs the hook setter CPI |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID`; target of the CPI |
| `event_authority` | no | no | UncheckedAccount | Added by `#[event_cpi]`; seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`; this program's own id |

### Execution

1. Preconditions above.
2. CPI → `transfer_hook::set_transfer_mode(mode.compliance_value())`, signed by `registry_writer`.
3. Emit `TransferControlModeSet`.

---

## Instruction: `add_to_control_list` (Management)

No parameters.

Puts a token account in the control list: sets `in_control_list` on its `AccountCompliance`, creating the record if absent. Idempotent — adding an account that is already listed succeeds and emits the event again.

### Preconditions

- `require_role(ROLE_CONTROL_LIST)` — the `authority` caller must sign and hold `ROLE_CONTROL_LIST` on this mint.
- `require_not_paused`, `require_active`
- `require_functionality(TRANSFER_CONTROL_ADD_TO_CONTROL_LIST)` — the mint's asset-class version must be finalized and have the `TRANSFER_CONTROL_ADD_TO_CONTROL_LIST` functionality bit enabled.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | yes | yes | Signer | Must hold `ROLE_CONTROL_LIST`; pays for the `AccountCompliance` record when `set_in_control_list` creates it |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` |
| `account` | no | no | UncheckedAccount | Token account whose membership changes; used as a seed |
| `mint_compliance_pda` | no | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; `deactivated` must be 0 (checked by `require_active`) |
| `account_compliance_pda` | yes | no | UncheckedAccount | seeds `["account_compliance", mint, account]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; may be absent; created/written by the `set_in_control_list` CPI |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `registry_writer` | no | no | UncheckedAccount | seeds `["registry_writer"]` (this program); signs the hook setter CPI |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID`; target of the CPI |
| `system_program` | no | no | Program<System> | Required by `set_in_control_list` (`init_if_needed` on the record) |
| `event_authority` | no | no | UncheckedAccount | Added by `#[event_cpi]`; seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`; this program's own id |

### Execution

1. Preconditions above.
2. CPI → `transfer_hook::set_in_control_list(true)`, signed by `registry_writer`, `payer = authority`.
3. Emit `AccountAddedToControlList`.

---

## Instruction: `remove_from_control_list` (Management)

No parameters.

Takes a token account out of the control list: clears `in_control_list` on its `AccountCompliance`. The record is kept (it may carry other compliance fields). Fails with `AccountNotInControlList` if the account is not listed (including when it has no record).

### Preconditions

- `require_role(ROLE_CONTROL_LIST)` — the `authority` caller must sign and hold `ROLE_CONTROL_LIST` on this mint.
- `require_not_paused`, `require_active`
- `require_functionality(TRANSFER_CONTROL_REMOVE_FROM_CONTROL_LIST)` — the mint's asset-class version must be finalized and have the `TRANSFER_CONTROL_REMOVE_FROM_CONTROL_LIST` functionality bit enabled.
- `common::in_control_list(account_compliance_pda)`, else `AccountNotInControlList`.

### Accounts

Same shape as `add_to_control_list`.

### Execution

1. Preconditions above.
2. CPI → `transfer_hook::set_in_control_list(false)`, signed by `registry_writer`.
3. Emit `AccountRemovedFromControlList`.

---

## Events

Each instruction emits an event via `emit_cpi!` (requires the `event-cpi` feature on `anchor-lang`
and the `event_authority` / `program` accounts above on the instruction context).

### `TransferControlModeSet`

Emitted at the end of `initialize`, after the mode has been written.

```rust
#[event]
pub struct TransferControlModeSet {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub mode: TransferMode,
}
```

### `AccountAddedToControlList`

Emitted at the end of `add_to_control_list`, including when the account was already listed.

```rust
#[event]
pub struct AccountAddedToControlList {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub operator: Pubkey,
}
```

### `AccountRemovedFromControlList`

Emitted at the end of `remove_from_control_list`.

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

`transfer-control` depends on `transfer-hook` (with `cpi`) for the setter CPIs; the hook does not depend on `transfer-control`, so there is no cycle.
