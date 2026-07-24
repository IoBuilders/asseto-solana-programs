# operations — Program Reference

Program ID: `BHDyg8PeUyVBpmkcjYLdnt3VCmYf4wp8Xeu6TXREiLKp`

Controls token burning via the Token-2022 `PermanentDelegate` extension. Owns the `["permanent_delegate", mint]` PDA that was registered as the permanent delegate during `deploy_mint`. The permanent delegate can burn tokens from any token account without the account owner's consent.

The `operations_authority` (permanent_delegate PDA) is one of the three callers accepted by `freeze`'s `block_account` / `unblock_account` instructions.

---

## Instruction: `burn` (Operational — controller only)

Burns `amount` tokens from any `token_account` for the given mint via the permanent delegate, without the holder's consent. Before burning, records the pre-burn total supply and holder balance into any active snapshot (no-ops when no snapshot has been taken yet).

### Parameters

```rust
amount: u64  // raw token units to burn
```

### Preconditions

- `require_role(ROLE_CONTROLLER)` — the `authority` caller must sign and hold `ROLE_CONTROLLER` on this mint (checked against its own `["roles", mint, authority]` PDA). Replaces the previous `verify_deployer` gate — burning is now role-based rather than restricted to the deployer.
- `require_active` — mint must not be deactivated.
- `require_functionality(OPERATIONS_BURN)` — the mint's asset-class version must enable burning.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Signs and pays for snapshot PDA creation |
| `authority` | no | yes | Signer | The caller; must hold `ROLE_CONTROLLER` on this mint |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; the caller's own PDA, loaded and read by `require_role` (must exist & be owned by `access-control`) |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint to burn from |
| `token_account` | yes | no | UncheckedAccount | The holder's token account to burn from |
| `operations_authority` | no | no | UncheckedAccount | seeds `["permanent_delegate", mint]` (owned by this program); signs unblock, snapshot, burn, and re-block CPIs |
| `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]`, `seeds::program = FREEZE_PROGRAM_ID`; passed to freeze |
| `snapshot_counter_pda` | no | no | UncheckedAccount | seeds `["snapshot_counter", mint]`, `seeds::program = SNAPSHOT_PROGRAM_ID`; may be empty |
| `total_supply_snapshot` | yes | no | UncheckedAccount | seeds `["snapshot_totalsupply", mint]`, `seeds::program = SNAPSHOT_PROGRAM_ID`; created/grown by snapshot |
| `holder_balance_snapshot` | yes | no | UncheckedAccount | seeds `["snapshot_holderbalance", mint, token_account]`, `seeds::program = SNAPSHOT_PROGRAM_ID`; created/grown by snapshot |
| `freeze_program` | no | no | UncheckedAccount | address constrained to `FREEZE_PROGRAM_ID` |
| `snapshot_program` | no | no | UncheckedAccount | address constrained to `SNAPSHOT_PROGRAM_ID` |
| `token_2022_program` | no | no | Program<Token2022> | |
| `system_program` | no | no | Program<System> | |

### Execution

1. `require_role(authority_roles_pda.load()?, ROLE_CONTROLLER)` — signer must hold the controller role
2. `require_active(&deactivate_pda)` + `require_functionality(OPERATIONS_BURN)`
3. CPI → `snapshot::update_totalsupply_snapshot` signed with `["permanent_delegate", mint, bump]` — records pre-burn supply into the active snapshot (no-op if none)
4. CPI → `snapshot::update_holderbalance_snapshot(0, true)` signed with `["permanent_delegate", mint, bump]` — records pre-burn holder balance (no adjustment)
5. CPI → `freeze::unblock_account(token_account)` signed with `["permanent_delegate", mint, bump]`
6. `invoke_signed` → `burn(token_account, mint, operations_authority, amount)` signed with `["permanent_delegate", mint, bump]`
7. CPI → `freeze::block_account(token_account)` signed with `["permanent_delegate", mint, bump]`

The unblock/re-block wrapper is required because all token accounts are frozen by default (`DefaultAccountState::Frozen`). Snapshot CPIs run before the balance change so the recorded value reflects the pre-burn state.

---

## Instruction: `batch_burn` (Operational — controller only)

Burns, in a single instruction, `amounts[i]` tokens from the `i`-th source token account. Runs the same authorization checks as `burn` (controller role, active, functionality) but **skips the snapshot CPIs** — batch burning does not record per-holder or total-supply snapshots. Unlike `batch_mint`, there is **no whitelist gate** (burning is never whitelist-restricted). Emits one `ControllerRedemption` event per source.

### Parameters

```rust
amounts: Vec<u64>  // raw token units per source; amounts[i] is burned from the i-th source
```

### Remaining accounts

One account per source, in order, appended as `remaining_accounts`:

| Offset (per source `i`) | Account | Mut | Notes |
|---|---|---|---|
| `i` | source token account | yes | burns `amounts[i]`; thawed → burned → re-frozen |

### Preconditions

- `!amounts.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() == amounts.len()` — errors `InvalidRemainingAccounts` otherwise (exactly one source per amount).
- `require_role(ROLE_CONTROLLER)` — the `authority` caller must sign and hold `ROLE_CONTROLLER` on this mint.
- `require_active` — mint must not be deactivated.
- `require_functionality(OPERATIONS_BURN)` — the mint's asset-class version must be finalized and enable burning.

### Accounts

The fixed accounts (the per-source token accounts are passed via `remaining_accounts`, see above).

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | no | yes | Signer | The caller; must hold `ROLE_CONTROLLER` on this mint |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint to burn from |
| `operations_authority` | no | no | UncheckedAccount | seeds `["permanent_delegate", mint]` (owned by this program); signs unblock, burn, and re-block CPIs |
| `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]`, `seeds::program = FREEZE_PROGRAM_ID`; passed to freeze |
| `freeze_program` | no | no | UncheckedAccount | address constrained to `FREEZE_PROGRAM_ID` |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `token_2022_program` | no | no | Program<Token2022> | |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID |

### Execution

1. `require!(!amounts.is_empty())` and `require!(remaining_accounts.len() == amounts.len())`
2. `require_role(ROLE_CONTROLLER)` + `require_active` + `require_functionality(OPERATIONS_BURN)`
3. For each source `i`:
   1. CPI → `freeze::unblock_account(source)` signed with `["permanent_delegate", mint, bump]`
   2. `invoke_signed` → `burn(source, mint, operations_authority, amounts[i])` signed with `["permanent_delegate", mint, bump]`
   3. Emit `ControllerRedemption { mint, controller: authority, from: source, value: amounts[i] }` via `emit_cpi!`
   4. CPI → `freeze::block_account(source)` signed with `["permanent_delegate", mint, bump]`

Unlike `burn`, no `snapshot::update_*` CPIs run — batch burning is snapshot-agnostic, so no `snapshot_counter` / `total_supply_snapshot` / `holder_balance_snapshot` accounts are required.

### Errors

| Code | Cause |
|---|---|
| `EmptyBatch` | `amounts` is empty |
| `InvalidRemainingAccounts` | `remaining_accounts.len() != amounts.len()` |

---

## Events

### `ControllerRedemption`

Emitted once per burned token account, after the tokens have been burned via the
permanent delegate and the account has been re-blocked — once for `burn`, and
once per source for `batch_burn`. Emitted via **`emit_cpi!`** (self-CPI) rather
than `emit!` so the payload is carried in an inner-instruction and cannot be
truncated by the ingestion layer — the same pattern `deploy` uses for
`MintDeployed`.

```rust
#[event]
pub struct ControllerRedemption {
    pub mint: Pubkey,
    pub controller: Pubkey,  // the `authority` that signed and holds ROLE_CONTROLLER (not `payer`)
    pub from: Pubkey,        // the token account burned from
    pub value: u64,          // raw token units burned
}
```

**Consumer notes:**
- `#[event_cpi]` appends two accounts to `burn`: `event_authority`
  (PDA `["__event_authority"]`) and `program`. Clients using `.accounts()` get
  them auto-resolved; `.accountsStrict()` must pass them explicitly.
- The event is **not** in `Program data:` logs. Read it from the transaction's
  inner instructions: strip the 8-byte self-CPI tag, then decode with the
  program event coder (see
  `tests/program_helpers/burn/burn_instruction_helper.ts::getControllerRedemptionEvent`,
  or `getControllerRedemptionEvents` for the multiple events emitted by `batch_burn`).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
