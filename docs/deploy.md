# deploy — Program Reference

Program ID: `HCe5Um7ThFBzDSyn256EPQvyr6jy6E66ydzZ5hMta3Tq`

Deploys new Token-2022 mints with all required extensions and records the deployer wallet in a PDA. This is the entry point for the entire system — all other programs trace authorization back to the `mint_owner_pda` created here.

---

## State: `MintOwner`

Seeds: `["mint_owner", mint]` — one per mint, owned by this program.

```rust
pub struct MintOwner {
    pub deployer: Pubkey,
    pub asset_class_config_id: u64,   // asset-class PDA seed (1/2)
    pub asset_class_version_id: u64,  // asset-class PDA seed (2/2)
    pub bump: u8,
}
// LEN = 8 (discriminator) + 32 (deployer) + 8 (asset_class_config_id) + 8 (asset_class_version_id) + 1 (bump) = 57 bytes
```

`asset_class_config_id` + `asset_class_version_id` are the seed of the factory asset-class PDA
(`["asset_class", config_id, version_id]`, owned by `factory`) this mint is
hooked to. The **seed** is stored — not the derived address — so downstream
programs re-derive that PDA with `seeds::program = FACTORY_PROGRAM_ID`, matching
how every other cross-program PDA is referenced in this workspace. The deployer
can re-point the mint to a newer asset-class version by updating these fields.

The fields are defined in `common::state::MintOwner` so downstream programs can deserialize it without importing `deploy`. This program defines its own `state::MintOwner` with `#[account]` (required for `Account<MintOwner>` usage) whose fields mirror `common`'s version and whose `LEN` delegates to it.

Downstream programs read this account through `common::verify_deployer`, which skips the 8-byte discriminator and Borsh-deserializes the remaining fields. `#[account]`'s full `AccountDeserialize` (with discriminator check) cannot be used in `common` because that macro requires `declare_id!`, which a library crate does not have. The discriminator check is redundant anyway since the `seeds::program` constraint in every caller already guarantees the correct account. The account is passed as `&AccountInfo` because `Account<T>` enforces ownership by the calling program, but this account is owned by `deploy`.

---

## Instruction: `deploy_mint`

### Parameters

```rust
pub struct DeployMintParams {
    pub decimals: u8,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub additional_metadata: Vec<MetadataField>,  // custom key-value pairs
    pub asset_class_config_id: u64,   // asset-class PDA seed (1/2) — persisted in mint_owner_pda
    pub asset_class_version_id: u64,  // asset-class PDA seed (2/2) — persisted in mint_owner_pda
}

pub struct MetadataField {
    pub key: String,
    pub value: String,
}
```

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Pays rent for mint account, `mint_owner_pda`, and `extra_account_meta_list` |
| `deployer` | no | yes | Signer | Stored as owner; can be same wallet as `payer` |
| `mint_owner_pda` | yes | no | `Account<MintOwner>` | init; seeds `["mint_owner", mint]` |
| `mint` | yes | yes | UncheckedAccount | Fresh keypair; must sign so SystemProgram can allocate it |
| `temp_mint_authority` | no | no | UncheckedAccount | PDA seeds `["temp_mint_authority", mint]`; no storage; used as transient signer for steps 9–12 |
| `mint_authority` | no | no | UncheckedAccount | seeds `["mint_authority", mint]`, `seeds::program = MINT_AUTHORITY_PROGRAM_ID` |
| `permanent_delegate_authority` | no | no | UncheckedAccount | seeds `["permanent_delegate", mint]`, `seeds::program = PERMANENT_DELEGATE_PROGRAM_ID` |
| `metadata_update_authority` | no | no | UncheckedAccount | seeds `["metadata_update_authority", mint]`, `seeds::program = METADATA_UPDATE_AUTHORITY_PROGRAM_ID` |
| `pausable_authority` | no | no | UncheckedAccount | seeds `["pausable_authority", mint]`, `seeds::program = PAUSABLE_AUTHORITY_PROGRAM_ID` |
| `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]`, `seeds::program = FREEZE_AUTHORITY_PROGRAM_ID` (`freeze`) |
| `transfer_hook_authority` | no | no | UncheckedAccount | seeds `["transfer_hook_authority", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID` |
| `extra_account_meta_list` | yes | no | UncheckedAccount | seeds `["extra-account-metas", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; created via CPI in step 14 |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID` |
| `token_2022_program` | no | no | Program<Token2022> | |
| `system_program` | no | no | Program<System> | |
| `rent` | no | no | Sysvar<Rent> | |

### 14-Step Execution

**1 — Size calculation**
- `base_size` = `ExtensionType::try_calculate_account_len` for the five fixed extensions (PermanentDelegate, MetadataPointer, Pausable, DefaultAccountState, TransferHook).
- `metadata_tlv_size` = `TokenMetadata { name, symbol, uri, additional_metadata }.tlv_size_of()`.
- Prefund lamports for `base_size + metadata_tlv_size`, but allocate only `base_size` bytes — Token-2022 reallocates in-place when `initialize_token_metadata` is called.

**2 — Create mint account** (`SystemProgram::create_account`)
- Owner: Token-2022 program. Size: `base_size`.

**3 — `initialize_metadata_pointer`**
- Metadata address: the mint itself (self-referential).
- Update authority: `None` — pointer is permanently immutable.

**4 — `initialize_permanent_delegate`**
- Delegate: `permanent_delegate_authority` PDA.

**5 — `initialize_default_account_state(Frozen)`**
- All new token accounts for this mint are created in Frozen state.

**6 — `initialize_pausable`**
- Authority: `pausable_authority` PDA.

**7 — `initialize_transfer_hook`**
- Authority: `transfer_hook_authority` PDA.
- Hook program: `TRANSFER_HOOK_PROGRAM_ID` (`transfer-hook`).
- Token-2022 will invoke the hook on every `transfer_checked`.

**8 — `initialize_mint2`**
- Mint authority: `temp_mint_authority` (this program's PDA — temporary).
- Freeze authority: `freeze_authority` PDA (owned by `freeze`).
- Decimals: from params.

**9 — `initialize_token_metadata`** (signed by `temp_mint_authority`)
- Stores name, symbol, URI in the mint account.
- Update authority: `temp_mint_authority` (temporary, transferred in step 11).

**10 — `update_field` loop** (signed by `temp_mint_authority`)
- One CPI per entry in `additional_metadata`, each writing a `Field::Key(key)` custom field.

**11 — `update_authority`** (signed by `temp_mint_authority`)
- Transfers metadata update authority from `temp_mint_authority` to `metadata_update_authority`.

**12 — `set_authority(MintTokens)`** (signed by `temp_mint_authority`)
- Transfers mint authority from `temp_mint_authority` to `mint_authority`.

**13 — Record deployer**
- Writes `deployer` pubkey, `asset_class_config_id`, `asset_class_version_id`, and PDA bump into `mint_owner_pda`.

**14 — CPI → `initialize_extra_account_meta_list`** (signed by `mint_owner_pda`)
- Calls `transfer_hook::initialize_extra_account_meta_list(deployer.key())`.
- Passes `mint_owner_pda` as signer via `invoke_signed` to prove the call originates from `deploy_mint`.
- The deployer pubkey is forwarded so the hook can bake it into the `ExtraAccountMetaList` (Token-2022 then passes the deployer account to `execute` on every transfer, enabling the clearing-mode signature check).
- Creates the populated `ExtraAccountMetaList` PDA (`["extra-account-metas", mint]`) inside `transfer-hook`.

### Why `temp_mint_authority`

`initialize_token_metadata` requires the **mint authority** to sign. At deploy time the deployer may not own any of the external authority programs (mint, etc.). By temporarily using a PDA this program owns as mint authority, it can sign that CPI itself, then hand off authority to the correct external programs in steps 11-12.

---

## Events

### `MintDeployed`

Emitted once at the end of a successful `deploy_mint` (step 15), after all
extensions, authorities and the transfer-hook metadata list are initialized.
Emitted via **`emit_cpi!`** (self-CPI) rather than `emit!` so the payload is
carried in an inner-instruction and cannot be truncated by the ingestion layer —
`deploy` is the first program in the workspace to adopt this pattern.

```rust
#[event]
pub struct MintDeployed {
    pub mint: Pubkey,
    pub deployer: Pubkey,
    pub decimals: u8,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub isin: Option<String>,  // from the additional_metadata entry keyed "isin"
    pub asset_class_config_id: u64,   // asset-class PDA seed (1/2)
    pub asset_class_version_id: u64,  // asset-class PDA seed (2/2)
}
```

**Consumer notes:**
- `#[event_cpi]` appends two accounts to `deploy_mint`: `event_authority`
  (PDA `["__event_authority"]`) and `program`. Clients using `.accounts()` get
  them auto-resolved; `.accountsStrict()` must pass them explicitly.
- The event is **not** in `Program data:` logs. Read it from the transaction's
  inner instructions: strip the 8-byte self-CPI tag, then decode with the
  program event coder (see `tests/program_helpers/deploy_helper.ts::getMintDeployedEvent`).

---

## Error Codes

```rust
MintAuthorityMustBeSigner,
InvalidMintAccountSize,
```

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
