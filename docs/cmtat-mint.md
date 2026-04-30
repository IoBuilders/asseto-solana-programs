# cmtat-mint — Program Reference

Program ID: `AXGtgWoPXfyfQ7o823WG2ip6qSRw1s3wA3RCSdtCyN1P`

Controls token minting. Owns the `["mint_authority", mint]` PDA that was set as the Token-2022 mint authority during `deploy_mint`. Only the deployer recorded in `mint_owner_pda` may call the mint instruction.

The `mint_authority` PDA also serves as one of the three accepted callers for `cmtat-freeze`'s block/unblock instructions.

---

## Instruction: `mint`

### Parameters

```rust
amount: u64  // raw token units (accounting for decimals)
```

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | no | yes | Signer | Must match pubkey stored in `mint_owner_pda` |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = CMTAT_DEPLOY_PROGRAM_ID` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = CMTAT_DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint to issue tokens from |
| `mint_authority` | no | no | UncheckedAccount | seeds `["mint_authority", mint]` (owned by this program); signs block/unblock and mint_to CPIs |
| `destination` | yes | no | UncheckedAccount | Token account receiving minted tokens; thawed before and re-frozen after minting |
| `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]`, `seeds::program = CMTAT_FREEZE_PROGRAM_ID`; passed through to cmtat-freeze |
| `transfer_control_mode_pda` | no | no | UncheckedAccount | seeds `["transfer_control_mode", mint]`, `seeds::program = CMTAT_TRANSFER_CONTROL_PROGRAM_ID`; read to check whitelist mode |
| `destination_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, destination]`, `seeds::program = CMTAT_TRANSFER_CONTROL_PROGRAM_ID`; must exist when whitelist mode is active |
| `block_program` | no | no | UncheckedAccount | address constrained to `CMTAT_FREEZE_PROGRAM_ID` |
| `token_2022_program` | no | no | Program<Token2022> | |

### Execution

1. `verify_deployer(&mint_owner_pda, &deployer.key())`
2. `verify_deactivate(&deactivate_pda)` — errors if the mint has been deactivated
3. If `is_whitelist_activated(&transfer_control_mode_pda)`: `verify_whitelist(&destination_whitelist_pda)` — errors if destination is not whitelisted
4. CPI → `cmtat_freeze::unblock_account(destination)` signed with `["mint_authority", mint, bump]`
5. `invoke_signed` → `mint_to(mint, destination, mint_authority, amount)` signed with `["mint_authority", mint, bump]`
6. CPI → `cmtat_freeze::block_account(destination)` signed with `["mint_authority", mint, bump]`

Steps 4–6 all sign with the same `mint_authority` PDA seeds. The thaw/re-freeze pattern is necessary because all token accounts are frozen by default (`DefaultAccountState::Frozen`).

---

## constants.rs

```rust
// Hardcoded — cannot use pub use cmtat_deploy::ID due to circular dependency
// (cmtat-deploy depends on cmtat-mint for its MINT_AUTHORITY_PROGRAM_ID).
pub const CMTAT_DEPLOY_PROGRAM_ID: Pubkey = Pubkey::new_from_array([...]);

// Hardcoded — cannot use pub use cmtat_deactivate::ID because that would create
// an indirect circular dependency through cmtat-deploy.
pub const CMTAT_DEACTIVATE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([...]);

// Sourced from crates — single source of truth.
pub use cmtat_freeze::ID             as CMTAT_FREEZE_PROGRAM_ID;
pub use cmtat_transfer_control::ID   as CMTAT_TRANSFER_CONTROL_PROGRAM_ID;
pub use cmtat_transfer_hook::ID      as CMTAT_TRANSFER_HOOK_PROGRAM_ID;
```
