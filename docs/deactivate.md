# deactivate — Program Reference

Program ID: `H2iRjVVKsKQMAnJKqiTfW2LGvT1G9tDqQ81DzRjxfX7V`

Permanently deactivates a Token-2022 mint by setting the `deactivated` flag in the transfer hook's `MintCompliance` record (`["mint_compliance", mint]`). That flag is the single source of truth: every other program checks it through `common::require_active` before executing, and `transfer-hook::execute` checks it on every transfer.

Deactivation is intentionally one-way: there is no `reactivate` instruction, and `set_deactivated` can only set the flag, never clear it.

This program holds no state of its own; it only owns the `registry_writer` signer PDA.

---

## PDA: `registry_writer`

`["registry_writer"]` (owned by this program, no data). Signs the `transfer-hook::set_deactivated` CPI; the hook accepts only this PDA as the writer of `MintCompliance.deactivated`.

---

## Instruction: `deactivate` (Management)

No parameters.

Sets the hook's `MintCompliance.deactivated` flag. After this call, all calls to `mint::mint`, `operations::burn`, `operations::controller_transfer`, `pause::pause/unpause`, and `transfer-control::set_mode` will fail with `CommonError::Deactivated`. Transfers are blocked inside `transfer-hook::execute`, which Token-2022 invokes on every `transfer_checked`, so no transfer path can miss the check.

### Preconditions

- `require_role(authority_roles_pda, ROLE_DEACTIVATE)` — `authority` must hold `ROLE_DEACTIVATE` on the `access-control` `Roles` PDA for this `(mint, authority)` pair (granted via `access-control::grant_roles`). This replaces the deployer-only check — any account holding the role may deactivate, not just the recorded deployer.
- `require_not_paused` — mint must not be paused (deactivation from paused state is disallowed).
- `require_active(mint_compliance_pda)` — the mint must not already be deactivated (a second call fails with `Deactivated`).
- `require_functionality(asset_class_version_pda, DEACTIVATE_DEACTIVATE)` — the mint's asset-class version must be finalized and have the `DEACTIVATE_DEACTIVATE` functionality bit enabled.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | no | yes | Signer | Must hold `ROLE_DEACTIVATE` |
| `authority_roles_pda` | no | no | `AccountLoader<Roles>` | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `asset_configuration_pda` | no | no | `Account<AssetConfiguration>` | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies `asset_class_config_id`/`asset_class_version_id` for `asset_class_version_pda`'s seeds |
| `mint` | no | no | UncheckedAccount | Read by `require_not_paused` (checks the Pausable extension) |
| `asset_class_version_pda` | no | no | `AccountLoader<AssetClassVersion>` | seeds `["asset_class_version", asset_configuration_pda.asset_class_config_id, asset_configuration_pda.asset_class_version_id]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `mint_compliance_pda` | yes | no | `AccountLoader<MintCompliance>` | seeds `["mint_compliance", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; read by `require_active`, written by the `set_deactivated` CPI |
| `registry_writer` | no | no | UncheckedAccount | seeds `["registry_writer"]` (this program); signs the `set_deactivated` CPI |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID`; target of the CPI |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `Deactivated` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI |

### Execution

1. `require_role(&authority_roles_pda, ROLE_DEACTIVATE)`
2. `require_not_paused(&mint)` — ensures the mint is not already paused
3. `require_functionality(&asset_class_version_pda, DEACTIVATE_DEACTIVATE)`
4. `require_active(mint_compliance_pda.load()?)`
5. CPI → `transfer_hook::set_deactivated`, signed by `registry_writer`, sets `MintCompliance.deactivated`
6. Emit `Deactivated { mint, operator: authority }` via `emit_cpi!`

### Events

| Event | Fields | Emitted |
|---|---|---|
| `Deactivated` | `mint: Pubkey`, `operator: Pubkey` | After `MintCompliance.deactivated` is set |

Emitted with `emit_cpi!` (not `emit!`), which records the event as a self-CPI captured in the transaction's `innerInstructions` rather than in program logs — avoiding log-truncation loss for off-chain indexers. This requires `#[event_cpi]` on `Deactivate` (injecting the `event_authority` and `program` accounts above) and the `event-cpi` feature on `anchor-lang` in `Cargo.toml`. Because these events live in inner instructions, Anchor's log-based `program.addEventListener` cannot see them; the test suite decodes them from `innerInstructions` instead (see `tests/program_helpers/event_helper.ts`).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
