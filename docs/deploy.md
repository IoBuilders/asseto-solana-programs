# deploy — Program Reference

Program ID: `HCe5Um7ThFBzDSyn256EPQvyr6jy6E66ydzZ5hMta3Tq`

---

## State: `AssetConfiguration`

Seeds: `["asset_configuration", mint]` — one per mint, owned by this program.

```rust
pub struct AssetConfiguration {
    pub asset_class_config_id: u64,   // asset-class PDA seed (1/2)
    pub asset_class_version_id: u64,  // asset-class PDA seed (2/2)
    pub bump: u8,
}
// LEN = 8 (discriminator) + 8 (asset_class_config_id) + 8 (asset_class_version_id) + 1 (bump) = 25 bytes
```

`asset_class_config_id` + `asset_class_version_id` are the seed of the factory asset-class PDA
(`["asset_class", config_id, version_id]`, owned by `factory`) this mint is
hooked to. The **seed** is stored — not the derived address — so downstream
programs re-derive that PDA with `seeds::program = FACTORY_PROGRAM_ID`, matching
how every other cross-program PDA is referenced in this workspace. The deployer
can re-point the mint to a newer asset-class version by updating these fields.

The fields are defined in `common::state::AssetConfiguration` so downstream programs can deserialize it without importing `deploy`. This program defines its own `state::AssetConfiguration` with `#[account]` (required for `Account<AssetConfiguration>` usage) whose fields mirror `common`'s version and whose `LEN` delegates to it.

Downstream programs read this account as a typed `Account<AssetConfiguration>` (using `common::state::AssetConfiguration`, seeded with `seeds::program = DEPLOY_PROGRAM_ID`) to pull the asset-class ids for their own `asset_class_version_pda` derivation. There is no longer a `verify_deployer` helper — access is now gated by `require_role` against each caller's own `access-control` `Roles` PDA, not by matching the signer against the `deployer` pubkey stored here.

---

## Instruction: `deploy_mint`

Deploys new Token-2022 mints with all required extensions. This is the entry point for the entire system — all other programs trace authorization back to the `asset_configuration_pda` created here. It also bootstraps access control: a final CPI to `access_control::initialize` grants the deployer `ROLE_ADMIN` on the new mint.

Sets up the following Token-2022 extensions, each governed by a distinct program-derived authority:

| Extension | Authority PDA seeds | Owner program |
|---|---|---|
| Mint authority | `["mint_authority", mint]` | `mint` (`MINT_PROGRAM_ID`) |
| `PermanentDelegate` | `["permanent_delegate", mint]` | `operations` (`OPERATIONS_PROGRAM_ID`) |
| `TransferHook` | `["transfer_hook_authority", mint]` | `transfer-hook` (`TRANSFER_HOOK_PROGRAM_ID`) |
| `MetadataPointer` | n/a (points to mint itself) | none — immutable |
| Metadata update | `["metadata_update_authority", mint]` | `metadata-update` (`METADATA_UPDATE_PROGRAM_ID`) |
| `Pausable` | `["pausable_authority", mint]` | `pause` (`PAUSE_PROGRAM_ID`) |
| `DefaultAccountState(Frozen)` | `["freeze_authority", mint]` | `freeze` (`FREEZE_PROGRAM_ID`) |

### Parameters

```rust
pub struct DeployMintParams {
    pub decimals: u8,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub additional_metadata: Vec<MetadataField>,  // custom key-value pairs
    pub asset_class_config_id: u64,   // asset-class PDA seed (1/2) — persisted in asset_configuration_pda
    pub asset_class_version_id: u64,  // asset-class PDA seed (2/2) — persisted in asset_configuration_pda
}

pub struct MetadataField {
    pub key: String,
    pub value: String,
}
```

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Pays rent for mint account, `asset_configuration_pda`, and `extra_account_meta_list` |
| `deployer` | no | yes | Signer | Granted `ROLE_ADMIN` on this mint in step 15; can be same wallet as `payer` |
| `asset_configuration_pda` | yes | no | `Account<AssetConfiguration>` | init; seeds `["asset_configuration", mint]` |
| `mint` | yes | yes | UncheckedAccount | Fresh keypair; must sign so SystemProgram can allocate it |
| `temp_mint_authority` | no | no | UncheckedAccount | PDA seeds `["temp_mint_authority", mint]`; no storage; used as transient signer for steps 9–12 and the `access_control::initialize` CPI in step 15 |
| `mint_authority` | no | no | UncheckedAccount | seeds `["mint_authority", mint]`, `seeds::program = MINT_PROGRAM_ID` |
| `permanent_delegate_authority` | no | no | UncheckedAccount | seeds `["permanent_delegate", mint]`, `seeds::program = OPERATIONS_PROGRAM_ID` |
| `metadata_update_authority` | no | no | UncheckedAccount | seeds `["metadata_update_authority", mint]`, `seeds::program = METADATA_UPDATE_PROGRAM_ID` |
| `pausable_authority` | no | no | UncheckedAccount | seeds `["pausable_authority", mint]`, `seeds::program = PAUSE_PROGRAM_ID` |
| `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]`, `seeds::program = FREEZE_PROGRAM_ID` |
| `transfer_hook_authority` | no | no | UncheckedAccount | seeds `["transfer_hook_authority", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID` |
| `extra_account_meta_list` | yes | no | UncheckedAccount | seeds `["extra-account-metas", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; created via CPI in step 14 |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID` |
| `token_2022_program` | no | no | Program<Token2022> | |
| `system_program` | no | no | Program<System> | |
| `rent` | no | no | Sysvar<Rent> | |
| `roles_pda` | yes | no | UncheckedAccount | seeds `["roles", mint, deployer]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; created via the CPI in step 15 |
| `access_control_program` | no | no | UncheckedAccount | address constrained to `ACCESS_CONTROL_PROGRAM_ID`; the program invoked by the step 15 CPI |

### 15-Step Execution

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

**13 — Record the mint configuration**
- Writes `asset_class_config_id`, `asset_class_version_id`, and PDA bump into `asset_configuration_pda`.

**14 — CPI → `initialize_extra_account_meta_list`** (signed by `asset_configuration_pda`)
- Calls `transfer_hook::initialize_extra_account_meta_list`.
- Passes `asset_configuration_pda` as signer via `invoke_signed` to prove the call originates from `deploy_mint`.
- Creates the populated `ExtraAccountMetaList` PDA (`["extra-account-metas", mint]`) inside `transfer-hook`.

**15 — CPI → `access_control::initialize`** (signed by `temp_mint_authority`)
- Grants `ROLE_ADMIN` to the `deployer` on this mint by creating the `roles_pda` (`[mint, deployer]`, owned by `access-control`).
- Passes `temp_mint_authority` as signer via `invoke_signed`; `access-control::initialize` checks the caller is exactly the deploy `["temp_mint_authority", mint]` PDA, so no external wallet can invoke it directly.
- `payer` funds the PDA; `deployer` (the `account` grantee) and `payer` sign the outer `deploy_mint` transaction, and those signatures propagate into the CPI.

### Why `temp_mint_authority`

`initialize_token_metadata` requires the **mint authority** to sign. At deploy time the deployer may not own any of the external authority programs (mint, etc.). By temporarily using a PDA this program owns as mint authority, it can sign that CPI itself, then hand off authority to the correct external programs in steps 11-12.

---

## Events

### `MintDeployed`

Emitted once at the end of a successful `deploy_mint` (step 16), after all
extensions, authorities, the transfer-hook metadata list, and the deployer's
`ROLE_ADMIN` grant are initialized.
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
