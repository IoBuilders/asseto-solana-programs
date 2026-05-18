# pause — Program Reference

Program ID: `5j3F89fmVVusjwy9z3Rv5wLaVj4ovhwctQ7TRBsxNghq`

Controls the Token-2022 `Pausable` extension. Owns the `["pausable_authority", mint]` PDA registered as the pausable authority during `deploy_mint`. When the mint is paused, Token-2022 rejects all `mint_to`, `burn`, and `transfer_checked` instructions at the protocol level.

The pause state is also checked by `common::require_not_paused`, which is called by `freeze` (management instructions) and `transfer-control` before any management operation.

---

## Instruction: `pause` (Management)

No parameters.

Pauses the Token-2022 mint. All minting, burning, and transfers are blocked by Token-2022 until `unpause` is called.

### Preconditions

- `verify_deployer` — only the deployer may pause.
- `require_active` — mint must not be deactivated.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | no | yes | Signer | Must match pubkey stored in `mint_owner_pda` |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint to pause |
| `pausable_authority` | no | no | UncheckedAccount | seeds `["pausable_authority", mint]` (owned by this program); signs the Token-2022 pause CPI |
| `token_2022_program` | no | no | Program<Token2022> | |

### Execution

1. `verify_deployer(&mint_owner_pda, &deployer.key())`
2. `require_active(&deactivate_pda)`
3. `invoke_signed` → `spl_pause(mint, pausable_authority)` signed with `["pausable_authority", mint, bump]`

---

## Instruction: `unpause` (Management)

No parameters.

Unpauses the Token-2022 mint. Resumes normal minting, burning, and transfers.

### Preconditions

- `verify_deployer` — only the deployer may unpause.
- `require_active` — mint must not be deactivated.

### Accounts

Same shape as `pause` but calls `spl_resume` (Token-2022 unpause instruction).

---

## constants.rs

```rust
// Sourced from crate — single source of truth.
pub use deploy::ID as DEPLOY_PROGRAM_ID;

// Sourced from crate.
pub use deactivate::ID as DEACTIVATE_PROGRAM_ID;
```
