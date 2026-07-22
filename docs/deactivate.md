# deactivate — Program Reference

Program ID: `H2iRjVVKsKQMAnJKqiTfW2LGvT1G9tDqQ81DzRjxfX7V`

Permanently deactivates a Token-2022 mint by creating an on-chain marker PDA. Once deactivated, the mint cannot be minted, burned, or operated on — every other program checks `require_active` before executing.

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

- `require_role(authority_roles_pda, ROLE_DEACTIVATE)` — `authority` must hold `ROLE_DEACTIVATE` on the `access-control` `Roles` PDA for this `(mint, authority)` pair (granted via `access-control::grant_roles`). This replaces the deployer-only check — any account holding the role may deactivate, not just the recorded deployer.
- `require_not_paused` — mint must not be paused (deactivation from paused state is disallowed).
- `require_functionality(asset_class_version_pda, DEACTIVATE_DEACTIVATE)` — the mint's asset-class version must be finalized and have the `DEACTIVATE_DEACTIVATE` functionality bit enabled.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | yes | yes | Signer | Funds the PDA creation; must hold `ROLE_DEACTIVATE` |
| `authority_roles_pda` | no | no | `AccountLoader<Roles>` | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `asset_configuration_pda` | no | no | `Account<AssetConfiguration>` | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies `asset_class_config_id`/`asset_class_version_id` for `asset_class_version_pda`'s seeds |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` (checks the Pausable extension) |
| `deactivate_pda` | yes | no | `Account<DeactivateStatus>` | init; seeds `["deactivate", mint]`; payer = `authority` |
| `asset_class_version_pda` | no | no | `AccountLoader<AssetClassVersion>` | seeds `["asset_class_version", asset_configuration_pda.asset_class_config_id, asset_configuration_pda.asset_class_version_id]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `system_program` | no | no | Program<System> | |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `Deactivated` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI |

### Execution

1. `require_role(&authority_roles_pda, ROLE_DEACTIVATE)`
2. `require_not_paused(&mint)` — ensures the mint is not already paused
3. `require_functionality(&asset_class_version_pda, DEACTIVATE_DEACTIVATE)`
4. Anchor `init` constraint creates and initializes `deactivate_pda` with `bump`
5. Emit `Deactivated { mint, operator: authority }` via `emit_cpi!`

### Events

| Event | Fields | Emitted |
|---|---|---|
| `Deactivated` | `mint: Pubkey`, `operator: Pubkey` | After the deactivation marker is initialized |

Emitted with `emit_cpi!` (not `emit!`), which records the event as a self-CPI captured in the transaction's `innerInstructions` rather than in program logs — avoiding log-truncation loss for off-chain indexers. This requires `#[event_cpi]` on `Deactivate` (injecting the `event_authority` and `program` accounts above) and the `event-cpi` feature on `anchor-lang` in `Cargo.toml`. Because these events live in inner instructions, Anchor's log-based `program.addEventListener` cannot see them; the test suite decodes them from `innerInstructions` instead (see `tests/program_helpers/event_helper.ts`).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
