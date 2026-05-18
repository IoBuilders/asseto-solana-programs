# deactivate — Program Reference

Program ID: `H2iRjVVKsKQMAnJKqiTfW2LGvT1G9tDqQ81DzRjxfX7V`

Permanently deactivates a Token-2022 mint by creating an on-chain marker PDA. Once deactivated, the mint cannot be minted, burned, or operated on — every other CMTAT program checks `require_active` before executing.

Deactivation is intentionally one-way: there is no `reactivate` instruction and the `deactivate_pda` is never closed.

---

## State: `DeactivateStatus`

```rust
#[account]
pub struct DeactivateStatus {
    pub bump: u8,
}
// LEN = 8 (discriminator) + 1 (bump) = 9 bytes
// Seeds: ["deactivate", mint]
```

Marker PDA. Its existence on-chain is the deactivation signal. `common::require_active` checks `data_is_empty()` on this account — if non-empty (i.e., initialized), it returns `Err(CommonError::Deactivated)`.

---

## Instruction: `deactivate` (Management)

No parameters.

Creates the `deactivate_pda` marker. After this call, all calls to `mint::mint`, `operations::burn`, `transfer::transfer`, `pause::pause/unpause`, and `transfer-control::set_mode` will fail with `CommonError::Deactivated`.

### Preconditions

- `verify_deployer` — only the deployer may deactivate.
- `require_not_paused` — mint must not be paused (deactivation from paused state is disallowed).

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | yes | yes | Signer | Funds the PDA creation |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` (checks the Pausable extension) |
| `deactivate_pda` | yes | no | `Account<DeactivateStatus>` | init; seeds `["deactivate", mint]` |
| `system_program` | no | no | Program<System> | |

### Execution

1. `verify_deployer(&mint_owner_pda, &deployer.key())`
2. `require_not_paused(&mint)` — ensures the mint is not already paused
3. Anchor `init` constraint creates and initializes `deactivate_pda` with `bump`

---

## constants.rs

```rust
// Sourced from crate — single source of truth.
pub use deploy::ID as DEPLOY_PROGRAM_ID;
```
