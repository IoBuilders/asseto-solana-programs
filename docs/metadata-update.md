# metadata-update — Program Reference

Program ID: `iShebeGRBZYSBMQYGAg8DbLnbaW2eDvX1Zt8EG9G1ZV`

Controls Token-2022 embedded metadata. Owns the `["metadata_update_authority", mint]` PDA that was set
as the metadata update authority during `deploy_mint`. Only an account holding `ROLE_CUSTOM_DATA_MANAGER` may call these instructions.

---

## Shared Accounts (both instructions)

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Pays rent when account must grow (defaults to `authority`) |
| `authority` | no | yes | Signer | Must hold `ROLE_CUSTOM_DATA_MANAGER` (verified via `authority_roles_pda`) |
| `authority_roles_pda` | no | no | AccountLoader<Roles> | seeds `[ROLES, mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint whose metadata is being modified |
| `asset_configuration_pda` | no | no | Account<AssetConfiguration> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; used to derive `asset_class_version_pda` |
| `metadata_update_authority` | no | no | UncheckedAccount | seeds `["metadata_update_authority", mint]` (owned) |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `asset_class_version_pda` | no | no | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `token_2022_program` | no | no | Program<Token2022> | |
| `system_program` | no | no | Program<System> | |
| `rent` | no | no | Sysvar<Rent> | `remove_metadata_field` only — not present on `update_metadata_field` |
| `event_authority` | no | no | UncheckedAccount | Added by `#[event_cpi]`; seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`; this program's own id |

`event_authority` signs the self-CPI that carries the emitted event; `program` is the self-CPI's target.

---

## Events

Both instructions emit an event via `emit_cpi!` (requires the `event-cpi` feature on `anchor-lang` and
the `event_authority` / `program` accounts above on the instruction context). In both events, `operator`
is the `authority` that signed the instruction.

### `MetadataFieldUpdated`

Emitted at the end of `update_metadata_field`, after the `update_field` CPI succeeds.

```rust
#[event]
pub struct MetadataFieldUpdated {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub key: String,
    pub value: String,
}
```

`key` / `value` are the field and value that were written — the same `key` / `value` the instruction was called with.

### `MetadataFieldRemoved`

Emitted at the end of `remove_metadata_field`, after the `remove_key` CPI succeeds — including when
`idempotent = true` and the key didn't exist beforehand, since Token-2022 still reports success in that
case.

```rust
#[event]
pub struct MetadataFieldRemoved {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub key: String,
}
```

`key` is the custom field that was removed.

---

## Instruction: `update_metadata_field`

Updates the value of an existing metadata field (name / symbol / uri or any custom key) or adds a new custom key-value pair if the key does not yet exist.

### Parameters

```rust
key: String,    // "name" | "symbol" | "uri" | any custom key
value: String,
```

### Key → Field mapping

```rust
"name"   => Field::Name
"symbol" => Field::Symbol
"uri"    => Field::Uri
_        => Field::Key(key)   // custom field; created if it doesn't exist
```

### Execution

1. `require_role(authority_roles_pda, ROLE_CUSTOM_DATA_MANAGER)`
2. `require_not_paused(&mint)`
3. `require_active(&deactivate_pda)`
4. `require_functionality(asset_class_version_pda, METADATA_UPDATE_UPDATE_METADATA_FIELD)`
5. Reads the mint's current `TokenMetadata` extension, simulates the field write, and computes the
   byte growth (`new_size - old_size`)
6. If that growth requires more rent than the mint account currently holds: `invoke` →
   `SystemProgram::transfer(payer, mint, additional_lamports)` to top up before the CPI so Token-2022
   can realloc in-place
7. `invoke_signed` → `update_field(mint, metadata_update_authority, field, value)` signed with seeds
   `["metadata_update_authority", mint, bump]`

### Account growth note

The additional-rent calculation is automatic — the instruction reads the mint's existing metadata,
simulates the update, and computes the exact byte growth itself. Callers don't need to precompute or
pass a target size; `payer` just needs enough lamports to cover the (possible) top-up.

---

## Instruction: `remove_metadata_field`

Removes a custom key-value pair from `additional_metadata`. Only custom keys can be removed — core fields (name, symbol, uri) cannot be removed (use `update_metadata_field` to clear their values instead); Token-2022 will reject the CPI if attempted.

### Parameters

```rust
key: String,
idempotent: bool  // if true, silently succeeds when the key doesn't exist
```

### Execution

1. `require_role(authority_roles_pda, ROLE_CUSTOM_DATA_MANAGER)`
2. `require_not_paused(&mint)`
3. `require_active(&deactivate_pda)`
4. `require_functionality(asset_class_version_pda, METADATA_UPDATE_REMOVE_METADATA_FIELD)`
5. `invoke_signed` → `remove_key(mint, metadata_update_authority, key, idempotent)` signed with seeds `["metadata_update_authority", mint, bump]`

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
