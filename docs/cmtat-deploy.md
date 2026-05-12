# cmtat-deploy — Program Reference

Program ID: `2XMEMg7FUxWksDRZQU9vtGHHSyKoSaH9bncj1noe38QK`

Deploys new Token-2022 mints with all required extensions and records the deployer wallet in a PDA. This is the entry point for the entire system — all other programs trace authorization back to the `mint_owner_pda` created here.

---

## State: `MintOwner`

Seeds: `["mint_owner", mint]` — one per mint, owned by this program.

```rust
pub struct MintOwner {
    pub deployer: Pubkey,
    pub bump: u8,
}
// LEN = 8 (discriminator) + 32 (deployer) + 1 (bump) = 41 bytes
```

The fields are defined in `cmtat-common::state::MintOwner` so downstream programs can deserialize it without importing `cmtat-deploy`. This program defines its own `state::MintOwner` with `#[account]` (required for `Account<MintOwner>` usage) whose fields mirror `cmtat-common`'s version and whose `LEN` delegates to it.

Downstream programs read this account through `cmtat_common::verify_deployer`, which skips the 8-byte discriminator and Borsh-deserializes the remaining fields. `#[account]`'s full `AccountDeserialize` (with discriminator check) cannot be used in `cmtat-common` because that macro requires `declare_id!`, which a library crate does not have. The discriminator check is redundant anyway since the `seeds::program` constraint in every caller already guarantees the correct account. The account is passed as `&AccountInfo` because `Account<T>` enforces ownership by the calling program, but this account is owned by `cmtat-deploy`.

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
| `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]`, `seeds::program = FREEZE_AUTHORITY_PROGRAM_ID` (`cmtat-freeze`) |
| `transfer_hook_authority` | no | no | UncheckedAccount | seeds `["transfer_hook_authority", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID` |
| `extra_account_meta_list` | yes | no | UncheckedAccount | seeds `["extra-account-metas", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; created via CPI in step 14 |
| `cmtat_transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID` |
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
- Hook program: `TRANSFER_HOOK_PROGRAM_ID` (`cmtat-transfer-hook`).
- Token-2022 will invoke the hook on every `transfer_checked`.

**8 — `initialize_mint2`**
- Mint authority: `temp_mint_authority` (this program's PDA — temporary).
- Freeze authority: `freeze_authority` PDA (owned by `cmtat-freeze`).
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
- Writes `deployer` pubkey and PDA bump into `mint_owner_pda`.

**14 — CPI → `initialize_extra_account_meta_list`** (signed by `mint_owner_pda`)
- Calls `cmtat_transfer_hook::initialize_extra_account_meta_list(deployer.key())`.
- Passes `mint_owner_pda` as signer via `invoke_signed` to prove the call originates from `deploy_mint`.
- The deployer pubkey is forwarded so the hook can bake it into the `ExtraAccountMetaList` (Token-2022 then passes the deployer account to `execute` on every transfer, enabling the clearing-mode signature check).
- Creates the populated `ExtraAccountMetaList` PDA (`["extra-account-metas", mint]`) inside `cmtat-transfer-hook`.

### Why `temp_mint_authority`

`initialize_token_metadata` requires the **mint authority** to sign. At deploy time the deployer may not own any of the external authority programs (cmtat-mint, etc.). By temporarily using a PDA this program owns as mint authority, it can sign that CPI itself, then hand off authority to the correct external programs in steps 11-12.

---

## Error Codes

```rust
MintAuthorityMustBeSigner,
InvalidMintAccountSize,
```

---

## constants.rs

All program IDs are imported directly from their crates — `declare_id!` is the single source of truth for each.

```rust
pub use cmtat_mint::ID             as MINT_AUTHORITY_PROGRAM_ID;
pub use cmtat_operations::ID       as PERMANENT_DELEGATE_PROGRAM_ID;
pub use cmtat_metadata_update::ID  as METADATA_UPDATE_AUTHORITY_PROGRAM_ID;
pub use cmtat_pause::ID            as PAUSABLE_AUTHORITY_PROGRAM_ID;
pub use cmtat_freeze::ID           as FREEZE_AUTHORITY_PROGRAM_ID;
pub use cmtat_transfer_hook::ID    as TRANSFER_HOOK_PROGRAM_ID;
```
