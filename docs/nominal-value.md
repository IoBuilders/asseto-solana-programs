# nominal-value — Program Reference

Program ID: `DJSxxL9WJkag9gCifqQs5EBD4uow9beP8CyDaZDj2rLL`

Records the nominal value of an asset — the value per unit (e.g. a fund's NAVPU) or the aggregate total (e.g. NAV) — in a typed PDA, one per mint. The program stores exactly what the caller provides: no unit/total arithmetic happens on-chain, and the publish type is metadata only.

Only the *current* period is kept on-chain. The full history of published and republished values is reconstructed off-chain from the `NominalValuePublished` / `NominalValueRepublished` events.

---

## State

### `NominalValue`

```rust
#[account]
pub struct NominalValue {
    pub bump: u8,
    pub nominal_value_currency: [u8; 3],
    pub nominal_value_publish_type: NominalValuePublishType,
    pub nominal_value_decimals: u8,
    pub nominal_value: u128,
    pub effective_datetime: i64,
}
// LEN = 8 (disc) + 1 + 3 + 1 + 1 + 16 + 8 = 38 bytes
// Seeds: ["nominal_value", mint]
```

| Field | Type | Meaning |
|---|---|---|
| `bump` | `u8` | Bump for the `["nominal_value", mint]` PDA. |
| `nominal_value_currency` | `[u8; 3]` | ISO 4217 currency code (e.g. `EUR` = `[69, 85, 82]`); `[0, 0, 0]` means unset. Fixed at `initialize_nominal_value`. |
| `nominal_value_publish_type` | `NominalValuePublishType` | `Unit` (per-unit figure, e.g. NAVPU) or `Total` (aggregate, e.g. NAV). Metadata only. Variant order is the on-chain encoding — append, never reorder. Fixed at `initialize_nominal_value`. |
| `nominal_value_decimals` | `u8` | Decimal scale applied to `nominal_value`. Fixed at `initialize_nominal_value`. |
| `nominal_value` | `u128` | Current nominal value, scaled by `nominal_value_decimals`. `u128` (not `u64`) so EVM-style 18-decimal scaling does not overflow. `0` until the first publish. |
| `effective_datetime` | `i64` | Unix timestamp (**seconds**) as of which `nominal_value` is effective. `i64` to compare directly with `Clock::unix_timestamp`. `0` until the first publish. |

---

## Error Codes

```rust
#[error_code]
pub enum ErrorCode {
    InvalidTimestamp,                 // effective_datetime <= 0
    EffectiveDatetimeNotAfterCurrent, // publish: not strictly greater than the stored datetime
    EffectiveDatetimeNotInPast,       // publish: not strictly before the cluster time
    EffectiveDatetimeMismatch,        // republish: not equal to the stored datetime
}
```

The role, pause, deactivation and functionality checks raise the shared `MissingRole`, `MintPaused`, `Deactivated`, `FunctionalityNotSupportedError` and `AssetClassVersionNotFinalized` errors from `common`. A second `initialize_nominal_value` fails in the System Program (account already in use) because of the `init` constraint.

---

## Instruction: `initialize_nominal_value` (Management)

Activates the nominal value capability for a mint and permanently records its currency, decimal precision and publish type. It does not set a value: `nominal_value` and `effective_datetime` start at zero until the first `publish_nominal_value`.

### Parameters

```rust
nominal_value_decimals: u8,
nominal_value_currency: [u8; 3],
nominal_value_publish_type: NominalValuePublishType,
```

### Preconditions

- `require_role(ROLE_ADMIN)` — the `authority` must hold `ROLE_ADMIN` on this mint.
- `require_not_paused` / `require_active`.
- `require_functionality(NOMINAL_VALUE_INITIALIZE)`.
- The PDA must not exist yet (`init`): the configuration can be set once and never changed.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Funds the `nominal_value_pda` rent. |
| `authority` | no | yes | Signer | Must hold `ROLE_ADMIN` |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID` |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | no | no | UncheckedAccount | Read-only; pause state checked by `require_not_paused` |
| `nominal_value_pda` | yes | no | `Account<NominalValue>` | `init`; seeds `["nominal_value", mint]` |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID` |
| `system_program` | no | no | Program\<System\> | |
| `event_authority` / `program` | no | no | UncheckedAccount | Added by `#[event_cpi]` |

### Execution steps

1. `require_role(ROLE_ADMIN)`, `require_not_paused`, `require_active`, `require_functionality(NOMINAL_VALUE_INITIALIZE)`.
2. Store the config; set `nominal_value` and `effective_datetime` to 0.
3. Emit `NominalValueInitialized { mint, operator, nominal_value_decimals, nominal_value_currency, nominal_value_publish_type }`.

---

## Instruction: `publish_nominal_value` (Management)

Records the nominal value for a new valuation period by overwriting both `nominal_value` and `effective_datetime`. The previous values are not retained on-chain; they remain in the `NominalValuePublished` event stream. A period can only be published once it has closed, and once a later period is published the earlier one is sealed.

### Parameters

```rust
nominal_value: u128,
effective_datetime: i64,   // seconds
```

### Preconditions

- `require_role(ROLE_NOMINAL_VALUE)`, `require_not_paused`, `require_active`, `require_functionality(NOMINAL_VALUE_PUBLISH)`.
- `effective_datetime > 0` (`InvalidTimestamp`).
- `effective_datetime >` the stored one (`EffectiveDatetimeNotAfterCurrent`).
- `effective_datetime <` `Clock::unix_timestamp` (`EffectiveDatetimeNotInPast`) — a value can only be anchored to a closed period.

### Accounts

Shared with `republish_nominal_value` (`WriteNominalValue`). Same as `initialize_nominal_value` minus `payer` and `system_program`, with `authority` needing `ROLE_NOMINAL_VALUE` and `nominal_value_pda` an existing, mutable PDA (`bump = nominal_value_pda.bump`).

### Execution steps

1. Role, pause, deactivation and functionality checks.
2. Validate `effective_datetime` as above.
3. Write `nominal_value` and `effective_datetime`.
4. Emit `NominalValuePublished { mint, operator, nominal_value, effective_datetime }`.

---

## Instruction: `republish_nominal_value` (Management)

Corrects the nominal value of the *current* period, leaving `effective_datetime` unchanged. Emits a distinct `NominalValueRepublished` event so indexers can tell a correction from a new period.

### Parameters

```rust
nominal_value: u128,
effective_datetime: i64,   // must equal the stored one
```

### Preconditions

- `require_role(ROLE_NOMINAL_VALUE)`, `require_not_paused`, `require_active`, `require_functionality(NOMINAL_VALUE_REPUBLISH)`.
- `effective_datetime > 0` (`InvalidTimestamp`).
- `effective_datetime ==` the stored one (`EffectiveDatetimeMismatch`). This also rejects republishing before anything was published, since the stored datetime is then 0.

### Execution steps

1. Role, pause, deactivation and functionality checks.
2. Validate `effective_datetime`.
3. Write `nominal_value` only.
4. Emit `NominalValueRepublished { mint, operator, nominal_value, effective_datetime }`.

---

## Constants

- `ROLE_NOMINAL_VALUE = 12` (`common::roles`) — a dedicated role, independent of `ROLE_CORPORATE_ACTION`. Granted/revoked through `access-control::grant_roles` / `revoke_roles`; this program has no authority-management instruction of its own.
- `NOMINAL_VALUE_INITIALIZE = 27`, `NOMINAL_VALUE_PUBLISH = 28`, `NOMINAL_VALUE_REPUBLISH = 29` (`common::functionalities`).
