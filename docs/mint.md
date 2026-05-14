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

### Execution

1. `verify_deployer(&mint_owner_pda, &deployer.key())`
2. `require_active(&deactivate_pda)` — errors if the mint has been deactivated
3. If whitelist mode is active (`get_transfer_mode(&transfer_control_mode_pda) == Some(TransferMode::Whitelist)`): `verify_whitelist(&destination_whitelist_pda)` — errors if destination is not whitelisted
4. CPI → `snapshot::update_totalsupply_snapshot` signed with `["mint_authority", mint, bump]` — records pre-mint supply into the active snapshot (no-op if none)
5. CPI → `snapshot::update_holderbalance_snapshot(0, true)` signed with `["mint_authority", mint, bump]` — records pre-mint destination balance (no adjustment)
6. CPI → `freeze::unblock_account(destination)` signed with `["mint_authority", mint, bump]`
7. `invoke_signed` → `mint_to(mint, destination, mint_authority, amount)` signed with `["mint_authority", mint, bump]`
8. CPI → `freeze::block_account(destination)` signed with `["mint_authority", mint, bump]`

Steps 4–8 all sign with the same `mint_authority` PDA seeds. The thaw/re-freeze pattern is necessary because all token accounts are frozen by default (`DefaultAccountState::Frozen`). Snapshot CPIs run before the balance change so the recorded value reflects the pre-mint state.

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
