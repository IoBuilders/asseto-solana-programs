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
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` (owned by this program); signs the self-CPI that emits `Paused` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID, target of the self-CPI |

### Execution

1. `verify_deployer(&mint_owner_pda, &deployer.key())`
2. `require_active(&deactivate_pda)`
3. `invoke_signed` → `spl_pause(mint, pausable_authority)` signed with `["pausable_authority", mint, bump]`
4. Emit `Paused { mint, operator: deployer }` via `emit_cpi!`

### Events

| Event | Fields | Emitted |
|---|---|---|
| `Paused` | `mint: Pubkey`, `operator: Pubkey` | After the Token-2022 pause CPI succeeds |

See [Emitting events](#emitting-events) below for why `emit_cpi!` is used and how the injected accounts work.

---

## Instruction: `unpause` (Management)

No parameters.

Unpauses the Token-2022 mint. Resumes normal minting, burning, and transfers.

### Preconditions

- `verify_deployer` — only the deployer may unpause.
- `require_active` — mint must not be deactivated.

### Accounts

Same shape as `pause` (including the `#[event_cpi]`-injected `event_authority` and `program` accounts) but calls `spl_resume` (Token-2022 unpause instruction).

### Events

| Event | Fields | Emitted |
|---|---|---|
| `Unpaused` | `mint: Pubkey`, `operator: Pubkey` | After the Token-2022 resume CPI succeeds |

---

## Emitting events

Both events are emitted with `emit_cpi!` (not `emit!`), which records the event as a self-CPI captured in the transaction's `innerInstructions` rather than in program logs — avoiding log-truncation loss for off-chain indexers. This requires `#[event_cpi]` on the `PauseMint` / `UnpauseMint` accounts structs (injecting the `event_authority` and `program` accounts) and the `event-cpi` feature on `anchor-lang` in `Cargo.toml`. Because these events live in inner instructions, Anchor's log-based `program.addEventListener` cannot see them; the test suite decodes them from `innerInstructions` instead (see `tests/program_helpers/event_helper.ts`).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
