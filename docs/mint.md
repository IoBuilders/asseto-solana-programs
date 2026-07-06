# mint — Program Reference

Program ID: `BgVv7zYbf3L4ECwaeNoNqD6unKWvQtgTwRJ2Dma7iSHQ`

Controls token minting. Owns the `["mint_authority", mint]` PDA that was set as the Token-2022 mint authority during `deploy_mint`. Only the deployer recorded in `mint_owner_pda` may call the mint instruction.

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
| `deployer` | no | yes | Signer | Must match pubkey stored in `mint_owner_pda` |
| `mint_owner_pda` | no | no | UncheckedAccount | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
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
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `Issued` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI |

### Execution

1. `verify_deployer(&mint_owner_pda, &deployer.key())`
2. `require_active(&deactivate_pda)` — errors if the mint has been deactivated
3. If whitelist mode is active (`get_transfer_mode(&transfer_control_mode_pda) == Some(TransferMode::Whitelist)`): `verify_whitelist(&destination_whitelist_pda)` — errors if destination is not whitelisted
4. CPI → `snapshot::update_totalsupply_snapshot` signed with `["mint_authority", mint, bump]` — records pre-mint supply into the active snapshot (no-op if none)
5. CPI → `snapshot::update_holderbalance_snapshot(0, true)` signed with `["mint_authority", mint, bump]` — records pre-mint destination balance (no adjustment)
6. CPI → `freeze::unblock_account(destination)` signed with `["mint_authority", mint, bump]`
7. `invoke_signed` → `mint_to(mint, destination, mint_authority, amount)` signed with `["mint_authority", mint, bump]`
8. Emit `Issued { mint, operator: deployer, to: destination, value: amount }` via `emit_cpi!`
9. CPI → `freeze::block_account(destination)` signed with `["mint_authority", mint, bump]`

Steps 4–7 and 9 all sign with the same `mint_authority` PDA seeds. The thaw/re-freeze pattern is necessary because all token accounts are frozen by default (`DefaultAccountState::Frozen`). Snapshot CPIs run before the balance change so the recorded value reflects the pre-mint state.

### Events

| Event | Fields | Emitted |
|---|---|---|
| `Issued` | `mint: Pubkey`, `operator: Pubkey`, `to: Pubkey`, `value: u64` | After the `mint_to` CPI succeeds (step 8) |

`Issued` is emitted with `emit_cpi!` rather than `emit!`. This instruction already performs 5 CPIs before minting (2× snapshot, 2× freeze thaw/re-freeze, 1× Token-2022 `mint_to`), each contributing its own program logs — `emit!` writes to the same log buffer (`Program data:`), which validators/RPC providers truncate around 10KB, risking silent event loss for off-chain indexers. `emit_cpi!` instead records the event as a self-CPI captured in the transaction's `innerInstructions`, which isn't subject to log truncation. This requires `#[event_cpi]` on `MintTokens`, which injects the `event_authority` and `program` accounts above, and the `event-cpi` feature enabled on `anchor-lang` in `Cargo.toml`.

Because `emit_cpi!` events live in inner instructions rather than program logs, Anchor's log-based `program.addEventListener` cannot see them; the test suite decodes them directly from `innerInstructions` instead (see `tests/program_helpers/event_helper.ts`, which handles both `emit!` and `emit_cpi!` events).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
