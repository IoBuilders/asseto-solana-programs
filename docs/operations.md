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

## Events

### `ControllerRedemption`

Emitted once at the end of a successful `burn` (step 6), after the tokens have
been burned via the permanent delegate and the account has been re-blocked.
Emitted via **`emit_cpi!`** (self-CPI) rather than `emit!` so the payload is
carried in an inner-instruction and cannot be truncated by the ingestion layer —
the same pattern `deploy` uses for `MintDeployed`.

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
  `tests/program_helpers/operations_helper.ts::getControllerRedemptionEvent`).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
