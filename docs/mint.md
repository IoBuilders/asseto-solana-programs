# mint — Program Reference

Program ID: `BgVv7zYbf3L4ECwaeNoNqD6unKWvQtgTwRJ2Dma7iSHQ`

Controls token minting. Owns the `["mint_authority", mint]` PDA that was set as the Token-2022 mint authority during `deploy_mint`. Minting is role-gated: the `authority` signer must hold `ROLE_ISSUER` on this mint (checked against its `access-control` `Roles` PDA via `require_role`). The `deployer` still signs and pays for snapshot-PDA creation but is no longer verified as the recorded mint owner.

The `mint_authority` PDA also serves as one of the three accepted callers for `freeze`'s block/unblock instructions.

---

## Instruction: `mint`

### Parameters

```rust
amount: u64  // raw token units (accounting for decimals)
```

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `deployer` | yes | yes | Signer | Signs and pays for snapshot PDA creation |
| `authority` | no | yes | Signer | The caller; must hold `ROLE_ISSUER` on this mint |
| `mint_owner_pda` | no | no | Account<MintOwner> | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint to issue tokens from |
| `mint_authority` | no | no | UncheckedAccount | seeds `["mint_authority", mint]` (owned by this program); signs block/unblock and mint_to CPIs |
| `destination` | yes | no | UncheckedAccount | Token account receiving minted tokens; thawed before and re-frozen after minting |
| `freeze_authority` | no | no | UncheckedAccount | seeds `["freeze_authority", mint]`, `seeds::program = FREEZE_PROGRAM_ID`; passed through to freeze |
| `transfer_control_mode_pda` | no | no | UncheckedAccount | seeds `["transfer_control_mode", mint]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; read to check whitelist mode |
| `destination_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, destination]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; must exist when whitelist mode is active |
| `snapshot_counter_pda` | no | no | UncheckedAccount | seeds `["snapshot_counter", mint]`, `seeds::program = SNAPSHOT_PROGRAM_ID`; may be empty |
| `total_supply_snapshot` | yes | no | UncheckedAccount | seeds `["snapshot_totalsupply", mint]`, `seeds::program = SNAPSHOT_PROGRAM_ID`; created/grown by snapshot |
| `holder_balance_snapshot` | yes | no | UncheckedAccount | seeds `["snapshot_holderbalance", mint, destination]`, `seeds::program = SNAPSHOT_PROGRAM_ID`; created/grown by snapshot |
| `freeze_program` | no | no | UncheckedAccount | address constrained to `FREEZE_PROGRAM_ID` |
| `snapshot_program` | no | no | UncheckedAccount | address constrained to `SNAPSHOT_PROGRAM_ID` |
| `token_2022_program` | no | no | Program<Token2022> | |
| `system_program` | no | no | Program<System> | |
| `authority_roles_pda` | no | no | AccountLoader<Roles> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read to verify `authority` holds `ROLE_ISSUER` |
| `asset_class_version_pda` | no | no | AccountLoader<AssetClassVersion> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `Issued` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI |

### Execution

1. `require_role(authority_roles_pda.load()?, ROLE_ISSUER)` — errors with `MissingRole` if `authority` does not hold the issuer role (or `RoleOutOfBounds` if the role id exceeds the mask)
2. `require_active(&deactivate_pda)` — errors if the mint has been deactivated
3. `require_functionality(asset_class_version_pda.load()?, MINT_MINT)` — errors if the mint's asset-class version isn't finalized or doesn't enable `MINT_MINT`
4. If whitelist mode is active (`get_transfer_mode(&transfer_control_mode_pda) == Some(TransferMode::Whitelist)`): `verify_whitelist(&destination_whitelist_pda)` — errors if destination is not whitelisted
5. CPI → `snapshot::update_totalsupply_snapshot` signed with `["mint_authority", mint, bump]` — records pre-mint supply into the active snapshot (no-op if none)
6. CPI → `snapshot::update_holderbalance_snapshot(0, true)` signed with `["mint_authority", mint, bump]` — records pre-mint destination balance (no adjustment)
7. CPI → `freeze::unblock_account(destination)` signed with `["mint_authority", mint, bump]`
8. `invoke_signed` → `mint_to(mint, destination, mint_authority, amount)` signed with `["mint_authority", mint, bump]`
9. Emit `Issued { mint, operator: authority, to: destination, value: amount }` via `emit_cpi!`
10. CPI → `freeze::block_account(destination)` signed with `["mint_authority", mint, bump]`

Steps 4–7 and 9 all sign with the same `mint_authority` PDA seeds. The thaw/re-freeze pattern is necessary because all token accounts are frozen by default (`DefaultAccountState::Frozen`). Snapshot CPIs run before the balance change so the recorded value reflects the pre-mint state.

### Events

| Event | Fields | Emitted |
|---|---|---|
| `Issued` | `mint: Pubkey`, `operator: Pubkey`, `to: Pubkey`, `value: u64` | After the `mint_to` CPI succeeds (step 8, emitted at step 9) |

`Issued` is emitted with `emit_cpi!` rather than `emit!`. This instruction already performs 5 CPIs before minting (2× snapshot, 2× freeze thaw/re-freeze, 1× Token-2022 `mint_to`), each contributing its own program logs — `emit!` writes to the same log buffer (`Program data:`), which validators/RPC providers truncate around 10KB, risking silent event loss for off-chain indexers. `emit_cpi!` instead records the event as a self-CPI captured in the transaction's `innerInstructions`, which isn't subject to log truncation. This requires `#[event_cpi]` on `MintTokens`, which injects the `event_authority` and `program` accounts above, and the `event-cpi` feature enabled on `anchor-lang` in `Cargo.toml`.

Because `emit_cpi!` events live in inner instructions rather than program logs, Anchor's log-based `program.addEventListener` cannot see them; the test suite decodes them directly from `innerInstructions` instead (see `tests/program_helpers/event_helper.ts`, which handles both `emit!` and `emit_cpi!` events).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
