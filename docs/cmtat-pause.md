# cmtat-pause — Program Reference

Program ID: `9GjHsbG5MgerXdyWRmNVMP9uXzi9iZyRyCrKw1LnSw1w`

Controls the Token-2022 `Pausable` extension. Owns the `["pausable_authority", mint]` PDA registered as the pausable authority during `deploy_mint`. When the mint is paused, Token-2022 rejects all `mint_to`, `burn`, and `transfer_checked` instructions at the protocol level.

The pause state is also checked by `cmtat-common::verify_unpause`, which is called by `cmtat-freeze` (management instructions) and `cmtat-transfer-control` before any management operation.

---

## Instruction: `pause` (Management)

No parameters.

Pauses the Token-2022 mint. All minting, burning, and transfers are blocked by Token-2022 until `unpause` is called.

### Preconditions

- `verify_deployer` — only the deployer may pause.
- `verify_deactivate` — mint must not be deactivated.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | no | yes | Signer | Must match pubkey stored in `mint_owner_pda` |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = CMTAT_DEPLOY_PROGRAM_ID` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = CMTAT_DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint to pause |
| `pausable_authority` | no | no | UncheckedAccount | seeds `["pausable_authority", mint]` (owned by this program); signs the Token-2022 pause CPI |
| `token_2022_program` | no | no | Program<Token2022> | |

### Execution

1. `verify_deployer(&mint_owner_pda, &deployer.key())`
2. `verify_deactivate(&deactivate_pda)`
3. `invoke_signed` → `spl_pause(mint, pausable_authority)` signed with `["pausable_authority", mint, bump]`

---

## Instruction: `unpause` (Management)

No parameters.

Unpauses the Token-2022 mint. Resumes normal minting, burning, and transfers.

### Preconditions

- `verify_deployer` — only the deployer may unpause.
- `verify_deactivate` — mint must not be deactivated.

### Accounts

Same shape as `pause` but calls `spl_resume` (Token-2022 unpause instruction).

---

## constants.rs

```rust
// Sourced from crate — single source of truth.
pub use cmtat_deploy::ID as CMTAT_DEPLOY_PROGRAM_ID;

// Sourced from crate.
pub use cmtat_deactivate::ID as CMTAT_DEACTIVATE_PROGRAM_ID;
```
