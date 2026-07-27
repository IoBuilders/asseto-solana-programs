# mint — Program Reference

Program ID: `BgVv7zYbf3L4ECwaeNoNqD6unKWvQtgTwRJ2Dma7iSHQ`

Controls token minting. Owns the `["mint_authority", mint]` PDA that was set as the Token-2022 mint authority during `deploy_mint`. Minting is role-gated: the `authority` signer must hold `ROLE_ISSUER` on this mint (checked against its `access-control` `Roles` PDA via `require_role`). `payer` funds snapshot-PDA creation but carries no authorization role itself.

The `mint_authority` PDA also serves as one of the three accepted callers for `freeze`'s block/unblock instructions.

---

## Instruction: `mint`

Mints `amount` tokens to `destination`. Before minting, records the pre-mint destination balance into any active snapshot (a no-op when no snapshot has been taken yet). Because all token accounts are frozen by default, thaws `destination` before minting and re-freezes it immediately after.

### Parameters

```rust
amount: u64  // raw token units (accounting for decimals)
```

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Signs and pays for snapshot PDA creation |
| `authority` | no | yes | Signer | The caller; must hold `ROLE_ISSUER` on this mint |
| `asset_configuration_pda` | no | no | Account<AssetConfiguration> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint to issue tokens from |
| `mint_authority` | no | no | UncheckedAccount | seeds `["mint_authority", mint]` (owned by this program); signs block/unblock and mint_to CPIs |
| `destination` | yes | no | UncheckedAccount | Token account receiving minted tokens; thawed before and re-frozen after minting |
| `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]`, `seeds::program = FREEZE_PROGRAM_ID`; passed through to freeze |
| `transfer_control_mode_pda` | no | no | UncheckedAccount | seeds `["transfer_control_mode", mint]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; read to check whitelist mode |
| `destination_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, destination]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; must exist when whitelist mode is active |
| `max_supply_pda` | no | no | UncheckedAccount | seeds `["max_supply", mint]`, `seeds::program = CAP_PROGRAM_ID`; may be empty only when the asset-class version does not enable `CAP_MAX_SUPPLY` |
| `snapshot_counter_pda` | no | no | UncheckedAccount | seeds `["snapshot_counter", mint]`, `seeds::program = SNAPSHOT_PROGRAM_ID`; may be empty |
| `holder_balance_snapshot` | yes | no | UncheckedAccount | seeds `["snapshot_holderbalance", mint, destination]`, `seeds::program = SNAPSHOT_PROGRAM_ID`; created/grown by snapshot |
| `freeze_program` | no | no | UncheckedAccount | address constrained to `FREEZE_PROGRAM_ID` |
| `snapshot_program` | no | no | UncheckedAccount | address constrained to `SNAPSHOT_PROGRAM_ID` |
| `token_2022_program` | no | no | Program<Token2022> | |
| `system_program` | no | no | Program<System> | |
| `authority_roles_pda` | no | no | AccountLoader<Roles> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read to verify `authority` holds `ROLE_ISSUER` |
| `asset_class_version_pda` | no | no | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` (`MINT_MINT`) and again by `cap::require_within_max_supply` (`CAP_MAX_SUPPLY`) |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `Issued` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI |

### Execution

1. `require_role(authority_roles_pda.load()?, ROLE_ISSUER)` — errors with `MissingRole` if `authority` does not hold the issuer role (or `RoleOutOfBounds` if the role id exceeds the mask)
2. `require_active(&deactivate_pda)` — errors if the mint has been deactivated
3. `require_functionality(asset_class_version_pda.load()?, MINT_MINT)` — errors if the mint's asset-class version isn't finalized or doesn't enable `MINT_MINT`
4. `transfer_control::verify_transfer_control_mode(&transfer_control_mode_pda, &[&destination_whitelist_pda])` — a no-op if `transfer_control_mode_pda` is empty (no mode active); otherwise, in whitelist mode, errors with `NotWhitelisted` if `destination_whitelist_pda` is empty
5. `cap::require_within_max_supply(&mint, &max_supply_pda, asset_class_version_pda.load()?, amount)` — errors with `MaxSupplyExceeded` if `supply + amount` exceeds the stored cap. When `max_supply_pda` is empty, the outcome depends on the asset-class version's `CAP_MAX_SUPPLY` bit: a no-op if the bit is unset (the mint opted out of capping), `MaxSupplyNotSet` if it is set (the mint is meant to be capped but `set_max_supply` was never called). Runs before the snapshot CPIs so a rejected mint leaves no writes behind
6. CPI → `snapshot::update_holderbalance_snapshot(0, true)` signed with `["mint_authority", mint, bump]` — records pre-mint destination balance (no adjustment)
7. CPI → `freeze::unblock_account(destination)` signed with `["mint_authority", mint, bump]`
8. `invoke_signed` → `mint_to(mint, destination, mint_authority, amount)` signed with `["mint_authority", mint, bump]`
9. Emit `Issued { mint, operator: authority, to: destination, value: amount }` via `emit_cpi!`
10. CPI → `freeze::block_account(destination)` signed with `["mint_authority", mint, bump]`

Steps 6–7 and 10 all sign with the same `mint_authority` PDA seeds. The thaw/re-freeze pattern is necessary because all token accounts are frozen by default (`DefaultAccountState::Frozen`). The snapshot CPI runs before the balance change so the recorded value reflects the pre-mint state.

### Events

| Event | Fields | Emitted |
|---|---|---|
| `Issued` | `mint: Pubkey`, `operator: Pubkey`, `to: Pubkey`, `value: u64` | After the `mint_to` CPI succeeds (step 7, emitted at step 8) |

`Issued` is emitted with `emit_cpi!` rather than `emit!`. This instruction already performs 4 CPIs before minting (1× snapshot, 2× freeze thaw/re-freeze, 1× Token-2022 `mint_to`), each contributing its own program logs — `emit!` writes to the same log buffer (`Program data:`), which validators/RPC providers truncate around 10KB, risking silent event loss for off-chain indexers. `emit_cpi!` instead records the event as a self-CPI captured in the transaction's `innerInstructions`, which isn't subject to log truncation. This requires `#[event_cpi]` on `MintTokens`, which injects the `event_authority` and `program` accounts above, and the `event-cpi` feature enabled on `anchor-lang` in `Cargo.toml`.

Because `emit_cpi!` events live in inner instructions rather than program logs, Anchor's log-based `program.addEventListener` cannot see them; the test suite decodes them directly from `innerInstructions` instead (see `tests/program_helpers/event_helper.ts`, which handles both `emit!` and `emit_cpi!` events).

---

## Instruction: `batch_mint`

Mints `amounts[i]` tokens to the `i`-th destination, for every index `i`, in a single instruction. Runs the same checks as `mint` (issuer role, active, functionality, whitelist) but does **not** touch snapshots — batch minting is not currently snapshot-aware. Per-destination token accounts and whitelist PDAs are passed via `remaining_accounts` (two entries per destination) rather than named struct fields, since Anchor can't declare a variable-length list of seed-constrained accounts.

### Parameters

```rust
amounts: Vec<u64>  // amounts[i] is minted to remaining_accounts[i*2]
```

### `remaining_accounts` layout

For each destination `i` (`0..amounts.len()`), two consecutive entries:

| Offset | Account | Notes |
|---|---|---|
| `i*2` | destination token account | Writable; thawed before and re-frozen after minting, like `mint`'s `destination` |
| `i*2 + 1` | destination's whitelist PDA | Not seed-constrained by Anchor (dynamic list) — re-derived and matched at runtime via `common::verify_whitelist_pda`, then checked for existence via `transfer_control::verify_whitelist` when whitelist mode is active |

### Preconditions

- `require!(!amounts.is_empty(), MintError::EmptyBatch)`
- `require!(ctx.remaining_accounts.len() == amounts.len() * 2, MintError::InvalidRemainingAccounts)`
- `require_role(authority_roles_pda, ROLE_ISSUER)`
- `require_active(&deactivate_pda)`
- `require_functionality(asset_class_version_pda, MINT_MINT)` — same functionality bit as `mint`, not a separate one
- `cap::require_within_max_supply(&mint, &max_supply_pda, asset_class_version_pda, sum(amounts))` — checked **once on the batch total**, not per destination. Equivalent to a per-destination check (the final supply is `initial + sum`, and every intermediate undershoots it) but pays the mint's TLV unpack once instead of `N` times, and fails before any CPI is issued. When `max_supply_pda` is empty it's a no-op if the asset-class version leaves `CAP_MAX_SUPPLY` unset, and errors with `MaxSupplyNotSet` if that bit is set. The sum itself is folded with `checked_add` and errors with `AmountOverflow` if it overflows `u64`
- When whitelist mode is active, **every** destination's whitelist PDA is verified (`WhitelistPdaMismatch` if the passed PDA isn't the one derived for that destination; `NotWhitelisted` if it is empty).

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | no | yes | Signer | The caller; must hold `ROLE_ISSUER` on this mint |
| `asset_configuration_pda` | no | no | Account<AssetConfiguration> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint to issue tokens from |
| `mint_authority` | no | no | UncheckedAccount | seeds `["mint_authority", mint]` (owned by this program); signs unblock/mint_to/block CPIs per destination |
| `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]`, `seeds::program = FREEZE_PROGRAM_ID`; passed through to freeze |
| `max_supply_pda` | no | no | UncheckedAccount | seeds `["max_supply", mint]`, `seeds::program = CAP_PROGRAM_ID`; may be empty only when the asset-class version does not enable `CAP_MAX_SUPPLY` |
| `transfer_control_mode_pda` | no | no | UncheckedAccount | seeds `["transfer_control_mode", mint]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; read once to determine whether whitelist mode is active for the whole batch |
| `freeze_program` | no | no | UncheckedAccount | address constrained to `FREEZE_PROGRAM_ID` |
| `asset_class_version_pda` | no | no | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` (`MINT_MINT`) and again by `cap::require_within_max_supply` (`CAP_MAX_SUPPLY`) |
| `token_2022_program` | no | no | Program<Token2022> | |
| `authority_roles_pda` | no | no | AccountLoader<Roles> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read to verify `authority` holds `ROLE_ISSUER` |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]`; signs the self-CPI that emits `Issued` (once per destination) |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI |
| *(remaining_accounts)* | varies | no | — | Two per destination — see layout above |

No `payer`/snapshot accounts: unlike `mint`, `batch_mint` doesn't create any snapshot PDAs (see below), so there's nothing to fund beyond what the destination token accounts already require.

### Execution

For each index `i` in `0..amounts.len()`:

1. If whitelist mode is active (`transfer_control_mode_pda` non-empty): `verify_whitelist_pda` then `verify_whitelist` on `remaining_accounts[i*2 + 1]`.
2. CPI → `freeze::unblock_account(destination)` signed with `["mint_authority", mint, bump]`.
3. `invoke_signed` → `mint_to(mint, destination, mint_authority, amounts[i])` signed with `["mint_authority", mint, bump]`.
4. Emit `Issued { mint, operator: authority, to: destination, value: amounts[i] }` via `emit_cpi!`.
5. CPI → `freeze::block_account(destination)` signed with `["mint_authority", mint, bump]`.

The role/active/functionality and supply-cap checks (see Preconditions) run once before the loop, not per destination.

### No snapshot integration

`batch_mint` does not CPI into `snapshot::update_holderbalance_snapshot` the way `mint` does. A batch mint performed while a snapshot is active will not be reflected in the destinations' recorded balances.

### Errors

| Code                       | Cause                                              |
|----------------------------|----------------------------------------------------|
| `EmptyBatch`               | `amounts` is empty                                 |
| `InvalidRemainingAccounts` | `remaining_accounts.len() != amounts.len() * 2`    |
| `WhitelistPdaMismatch`     | `the passed whitelist PDA isn't correctly derived` |
| `NotWhitelisted`           | `remaining_accounts.len() != amounts.len() * 2`    |
| `AmountOverflow`           | the sum of `amounts` overflows `u64`               |
| `MaxSupplyExceeded`        | `supply + sum(amounts)` exceeds the stored cap     |
| `MaxSupplyNotSet`          | `CAP_MAX_SUPPLY` is enabled but the `max_supply` PDA doesn't exist |

---
```

Plus `common::CommonError::WhitelistPdaMismatch` (from `verify_whitelist_pda`) and `transfer_control::TransferControlError::NotWhitelisted` (from `verify_whitelist`) when whitelist mode is active.

### Events

Same `Issued` event as `mint` (see above) — emitted once per destination, in order.

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
