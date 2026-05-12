# cmtat-operations — Program Reference

Program ID: `BANmGRnoLxXCTzKm2aM1Zww8qn7GN2KBkbyY7QpW3vcX`

Controls token burning via the Token-2022 `PermanentDelegate` extension. Owns the `["permanent_delegate", mint]` PDA that was registered as the permanent delegate during `deploy_mint`. The permanent delegate can burn tokens from any token account without the account owner's consent.

The `operations_authority` (permanent_delegate PDA) is one of the three callers accepted by `cmtat-freeze`'s `block_account` / `unblock_account` instructions.

---

## Instruction: `burn` (Management)

### Parameters

```rust
amount: u64  // raw token units to burn
```

### Preconditions

- `verify_deployer` — only the deployer may burn.
- `verify_deactivate` — mint must not be deactivated.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | no | yes | Signer | Must match pubkey stored in `mint_owner_pda` |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = CMTAT_DEPLOY_PROGRAM_ID` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = CMTAT_DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint to burn from |
| `token_account` | yes | no | UncheckedAccount | The holder's token account to burn from |
| `operations_authority` | no | no | UncheckedAccount | seeds `["permanent_delegate", mint]` (owned by this program); signs unblock, snapshot, burn, and re-block CPIs |
| `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]`, `seeds::program = CMTAT_FREEZE_PROGRAM_ID`; passed to cmtat-freeze |
| `snapshot_counter_pda` | no | no | UncheckedAccount | seeds `["snapshot_counter", mint]`, `seeds::program = CMTAT_SNAPSHOT_PROGRAM_ID`; may be empty |
| `total_supply_snapshot` | yes | no | UncheckedAccount | seeds `["snapshot_totalsupply", mint]`, `seeds::program = CMTAT_SNAPSHOT_PROGRAM_ID`; created/grown by cmtat-snapshot |
| `holder_balance_snapshot` | yes | no | UncheckedAccount | seeds `["snapshot_holderbalance", mint, token_account]`, `seeds::program = CMTAT_SNAPSHOT_PROGRAM_ID`; created/grown by cmtat-snapshot |
| `freeze_program` | no | no | UncheckedAccount | address constrained to `CMTAT_FREEZE_PROGRAM_ID` |
| `snapshot_program` | no | no | UncheckedAccount | address constrained to `CMTAT_SNAPSHOT_PROGRAM_ID` |
| `token_2022_program` | no | no | Program<Token2022> | |
| `system_program` | no | no | Program<System> | |

### Execution

1. `verify_deployer(&mint_owner_pda, &deployer.key())`
2. `verify_deactivate(&deactivate_pda)`
3. CPI → `cmtat_snapshot::update_totalsupply_snapshot` signed with `["permanent_delegate", mint, bump]` — records pre-burn supply into the active snapshot (no-op if none)
4. CPI → `cmtat_snapshot::update_holderbalance_snapshot(0, true)` signed with `["permanent_delegate", mint, bump]` — records pre-burn holder balance (no adjustment)
5. CPI → `cmtat_freeze::unblock_account(token_account)` signed with `["permanent_delegate", mint, bump]`
6. `invoke_signed` → `burn(token_account, mint, operations_authority, amount)` signed with `["permanent_delegate", mint, bump]`
7. CPI → `cmtat_freeze::block_account(token_account)` signed with `["permanent_delegate", mint, bump]`

The unblock/re-block wrapper is required because all token accounts are frozen by default (`DefaultAccountState::Frozen`). Snapshot CPIs run before the balance change so the recorded value reflects the pre-burn state.

---

## constants.rs

```rust
// Hardcoded — cmtat-deploy depends on cmtat-operations for PERMANENT_DELEGATE_PROGRAM_ID.
pub const CMTAT_DEPLOY_PROGRAM_ID: Pubkey = Pubkey::new_from_array([...]);

// Hardcoded — kept in sync manually.
pub const CMTAT_DEACTIVATE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([...]);

// Sourced from crates.
pub use cmtat_freeze::ID   as CMTAT_FREEZE_PROGRAM_ID;
pub use cmtat_snapshot::ID as CMTAT_SNAPSHOT_PROGRAM_ID;
```
