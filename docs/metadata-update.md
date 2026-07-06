# metadata-update — Program Reference

Program ID: `iShebeGRBZYSBMQYGAg8DbLnbaW2eDvX1Zt8EG9G1ZV`

Controls Token-2022 embedded metadata. Owns the `["metadata_update_authority", mint]` PDA that was set
as the metadata update authority during `deploy_mint`. Only the deployer may call these instructions.

---

## Shared Accounts (both instructions)

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Pays rent when account must grow |
| `deployer` | no | yes | Signer | Must match pubkey stored in `mint_owner_pda` |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint whose metadata is being modified |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `metadata_update_authority` | no | no | UncheckedAccount | seeds `["metadata_update_authority", mint]` (owned) |
| `token_2022_program` | no | no | Program<Token2022> | |
| `system_program` | no | no | Program<System> | |
| `rent` | no | no | Sysvar<Rent> | |
| `event_authority` | no | no | UncheckedAccount | Added by `#[event_cpi]`; seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`; this program's own id |

`event_authority` signs the self-CPI that carries the emitted event; `program` is the self-CPI's target.

---

## Events

Both instructions emit an event via `emit_cpi!` (requires the `event-cpi` feature on `anchor-lang` and
the `event_authority` / `program` accounts above on the instruction context). In both events, `operator`
is the `deployer` that signed the instruction.

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

### Parameters

```rust
key: String,               // "name" | "symbol" | "uri" | any custom key
value: String,
new_mint_size: Option<u64> // required when the account data grows
```

### Key → Field mapping

```rust
"name"   => Field::Name
"symbol" => Field::Symbol
"uri"    => Field::Uri
_        => Field::Key(key)   // custom field; created if it doesn't exist
```

### Execution

1. `verify_deployer(&mint_owner_pda, &deployer.key())`
2. If `new_mint_size` is `Some(new_size)` and `new_size > current_size`:
   - Calculate `additional_lamports = rent.minimum_balance(new_size) - mint.lamports()`
   - `invoke` `SystemProgram::transfer(payer, mint, additional_lamports)` to top up before the CPI so
     Token-2022 can realloc in-place
3. `invoke_signed` → `update_field(mint, metadata_update_authority, field, value)` signed with seeds
   `["metadata_update_authority", mint, bump]`

### Account growth note

Always pass `new_mint_size` when adding a new custom field or replacing a value with a longer one. Pass
`None` only when you are certain the account already has enough space (e.g. updating core fields with
equal or shorter values). The caller is responsible for calculating the target size off-chain.

---

## Instruction: `remove_metadata_field`

### Parameters

```rust
key: String,
idempotent: bool  // if true, silently succeeds when the key doesn't exist
```

Core fields (name, symbol, uri) cannot be removed — Token-2022 will reject the CPI.

### Execution

1. `verify_deployer(&mint_owner_pda, &deployer.key())`
2. `invoke_signed` → `remove_key(mint, metadata_update_authority, key, idempotent)` signed with seeds `["metadata_update_authority", mint, bump]`

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
