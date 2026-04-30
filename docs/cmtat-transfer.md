# cmtat-transfer — Program Reference

Program ID: `EY3ndaFy8e647firyg1MiyNH9LJkBKfV9VK8CNc4N1MD`

The custom CMTAT transfer endpoint. Token holders call this program instead of Token-2022 directly. It enforces all compliance checks before delegating to `transfer_checked`.

Owns the `["transfer", mint]` PDA which acts as the signing authority for the block/unblock CPIs to `cmtat-freeze`. This PDA is one of the three callers accepted by `cmtat-freeze`'s auxiliary instructions.

---

## Instruction: `transfer` (Operational)

### Parameters

```rust
amount: u64  // raw token units (accounting for decimals)
```

### Preconditions (in execution order)

1. `source_owner` must own `source` (verified by reading the token account state).
2. `verify_deactivate` — mint must not be deactivated.
3. Transfer control mode check:
   - If **clearing mode** (`is_clearing_activated`): `verify_deployer` — the deployer must also sign.
   - If **whitelist mode** (`is_whitelist_activated`): both `source_whitelist_pda` and `destination_whitelist_pda` must exist.
4. `verify_frozen_account(&source_frozen_pda)` — source must not be fully frozen.
5. `verify_frozen_account_balance(amount, source, source_frozen_balance_pda)` — unfrozen balance must cover the transfer.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `source_owner` | no | yes | Signer | Owner of the source token account |
| `deployer` | no | yes | Signer | Required to sign only in clearing mode; present in all cases |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = CMTAT_DEPLOY_PROGRAM_ID` |
| `transfer_control_mode_pda` | no | no | UncheckedAccount | seeds `["transfer_control_mode", mint]`, `seeds::program = CMTAT_TRANSFER_CONTROL_PROGRAM_ID` |
| `source_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, source]`, `seeds::program = CMTAT_TRANSFER_CONTROL_PROGRAM_ID` |
| `destination_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, destination]`, `seeds::program = CMTAT_TRANSFER_CONTROL_PROGRAM_ID` |
| `source` | yes | no | UncheckedAccount | Source token account |
| `destination` | yes | no | UncheckedAccount | Destination token account |
| `mint` | no | no | UncheckedAccount | Token-2022 mint; decimals read for `transfer_checked` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = CMTAT_DEACTIVATE_PROGRAM_ID` |
| `transfer_authority` | no | no | UncheckedAccount | seeds `["transfer", mint]` (owned by this program); signs block/unblock CPIs |
| `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]`, `seeds::program = CMTAT_FREEZE_PROGRAM_ID` |
| `source_frozen_pda` | no | no | UncheckedAccount | seeds `["frozen_account", mint, source]`, `seeds::program = CMTAT_FREEZE_PROGRAM_ID` |
| `source_frozen_balance_pda` | no | no | UncheckedAccount | seeds `["frozen_balance", mint, source]`, `seeds::program = CMTAT_FREEZE_PROGRAM_ID` |
| `extra_account_meta_list` | no | no | UncheckedAccount | seeds `["extra-account-metas", mint]`, `seeds::program = CMTAT_TRANSFER_HOOK_PROGRAM_ID`; required by Token-2022 |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `CMTAT_TRANSFER_HOOK_PROGRAM_ID` |
| `block_program` | no | no | UncheckedAccount | address constrained to `CMTAT_FREEZE_PROGRAM_ID` |
| `token_2022_program` | no | no | Program<Token2022> | |

### Execution

1. Verify `source_owner` is the owner of `source` (read token account state).
2. `verify_deactivate(&deactivate_pda)`
3. If clearing mode: `verify_deployer(&mint_owner_pda, &deployer.key())`
   Else if whitelist mode: `verify_whitelist(&source_whitelist_pda)` + `verify_whitelist(&destination_whitelist_pda)`
4. `verify_frozen_account(&source_frozen_pda)`
5. `verify_frozen_account_balance(amount, &source, &source_frozen_balance_pda)`
6. Read `decimals` from `mint` (required by `transfer_checked`)
7. CPI → `cmtat_freeze::unblock_account(source)` signed with `["transfer", mint, bump]`
8. CPI → `cmtat_freeze::unblock_account(destination)` signed with `["transfer", mint, bump]`
9. `invoke` → `transfer_checked(source, mint, destination, source_owner, amount, decimals)` with `extra_account_meta_list` and `transfer_hook_program` appended to the instruction's account list (required for Token-2022 to invoke the transfer hook).
10. CPI → `cmtat_freeze::block_account(source)` signed with `["transfer", mint, bump]`
11. CPI → `cmtat_freeze::block_account(destination)` signed with `["transfer", mint, bump]`

### Transfer hook account list note

`transfer_checked` builds only 4 `AccountMeta` entries. Token-2022 uses `instruction.accounts` to discover accessible accounts during the hook invocation, so `extra_account_meta_list` and `transfer_hook_program` must be **appended to `transfer_ix.accounts`** before the `invoke` call — passing them only in the `AccountInfo` slice is not sufficient.

---

## constants.rs

```rust
// Hardcoded — cmtat-deploy depends on cmtat-transfer indirectly (through cmtat-freeze),
// preventing a crate import.
pub const CMTAT_DEPLOY_PROGRAM_ID:     Pubkey = Pubkey::new_from_array([...]);
pub const CMTAT_DEACTIVATE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([...]);

// Sourced from crates.
pub use cmtat_freeze::ID             as CMTAT_FREEZE_PROGRAM_ID;
pub use cmtat_transfer_control::ID   as CMTAT_TRANSFER_CONTROL_PROGRAM_ID;
pub use cmtat_transfer_hook::ID      as CMTAT_TRANSFER_HOOK_PROGRAM_ID;
```
