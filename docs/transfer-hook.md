# transfer-hook — Program Reference

Program ID: `2qjsucJfrjP93FCwnYjc9EjYzYS8u31eWHhQo1jR9pcg`

Implements the [SPL Transfer Hook Interface](https://spl.solana.com/transfer-hook-interface).
Token-2022 invokes `execute` automatically on every `transfer_checked` call
for mints that have this program registered in their `TransferHook` extension.

Two responsibilities:

1. **Introspection gate.** Reads the `Instructions` sysvar and refuses the
   transfer unless the previous (N-1) and current (N) top-level instructions
   form one of two recognised pairs, both with arguments matching the hooked
   transfer:
   - **Single** — N-1 is `transfer::verify_transfer` and N is one of two
     known-good entrypoints (`operations::controller_transfer`, or a bare
     top-level `Token-2022::TransferChecked`).
   - **Batch** — N-1 is `transfer::batch_verify_transfer` and N is
     `transfer::batch_transfer`. The hook fires once per leg, so each leg is
     matched individually against both instructions, and the two are also
     required to describe the *identical ordered* batch.

   This is the only compliance enforcement the hook does; the actual rule checks
   (deactivation, transfer-mode, whitelist, frozen account, frozen balance)
   live in `transfer::verify_transfer` / `transfer::batch_verify_transfer` so
   the metalist stays small
   enough for Token-2022's 32 KiB heap to resolve it (see
   [`transfer-hook-heap-oom.md`](transfer-hook-heap-oom.md)).
2. **Functionality gate.** Reads the mint's `asset_configuration_pda` to
   locate its `asset_class_version_pda` and requires the
   `TRANSFER_HOOK_EXECUTE` bit to be enabled.

The hook writes **no state at all** — it only reads and either passes or
aborts the transfer.

Owns two mint-scoped PDAs: `["transfer_hook_authority", mint]` (the Token-2022
extension authority, set on the mint at deploy time) and
`["extra-account-metas", mint]` (the SPL `ExtraAccountMetaList`).

---

## PDAs

| Seeds | Purpose |
|---|---|
| `["transfer_hook_authority", mint]` | Token-2022 TransferHook extension authority. Recorded on the mint by `deploy_mint`; not passed to `execute` and never used as a signer |
| `["extra-account-metas", mint]` | SPL `ExtraAccountMetaList` — declares which extra accounts Token-2022 forwards to `execute` |

---

## Instruction: `initialize_extra_account_meta_list` (Auxiliary)

### Parameters

None.

Creates and populates the `ExtraAccountMetaList` PDA. Called exclusively via
CPI from `deploy::deploy_mint`, authorised by requiring `asset_configuration_pda`
as `Signer` — only `deploy` can produce that signature.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Funds rent |
| `asset_configuration_pda` | no | yes | UncheckedAccount | Signer proves the call originates from `deploy_mint`; seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `extra_account_meta_list` | yes | no | AccountInfo | init; seeds `["extra-account-metas", mint]`; size = `ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_META_COUNT)` (currently 5) |
| `mint` | no | no | UncheckedAccount | Seed component and PDA-precompute input |
| `system_program` | no | no | Program<System> | |
| `rent` | no | no | Sysvar<Rent> | |

### Metalist contents

The metalist lists only what `execute` actually reads. Keeping it small is
what lets Token-2022 fit metalist resolution into its 32 KiB heap.

| Hook idx | Entry | Kind |
|---|---|---|
| 5 | `deploy` program | literal pubkey — needed to resolve @6 as an external PDA |
| 6 | `asset_configuration_pda` | external PDA via @5 — seeds `["asset_configuration", mint@1]` |
| 7 | `factory` program | literal pubkey — needed to resolve @8 as an external PDA |
| 8 | `asset_class_version_pda` | external PDA via @7 — seeds `["asset_class_version", @6.asset_class_config_id, @6.asset_class_version_id]`, read from @6's data at `ASSET_CLASS_CONFIG_ID_OFFSET` / `ASSET_CLASS_VERSION_ID_OFFSET` |
| 9 | Instructions sysvar | literal pubkey (`Sysvar1nstructions...`) — required by the introspection check |

Every entry is read-only: the hook never writes.

Two rounds of entries have been removed from this list:

- The 10 compliance entries dropped before commit `7d417c2`'s heap-OOM
  incident (`asset_configuration_pda`, `deactivate_pda`, `deployer`,
  `transfer_control_mode_pda`, `transfer-control` program, source/destination
  whitelist PDAs, `freeze` program, `source_frozen_pda`,
  `source_frozen_balance_pda`) — `verify_transfer` consumes them directly at
  the top level instead.
- The 6 snapshot entries (`snapshot` program, `snapshot_counter_pda`,
  `sender_snapshot`, `receiver_snapshot`, `transfer_hook_authority`, system
  program) — holder balances are no longer accumulated per transfer; each
  snapshot now commits every `(account, balance)` pair to a single on-chain
  Merkle root (`["snapshot_merkle_root", mint, snapshot_id]`), and consumers
  such as `treasury::pay_coupon` prove a balance against that root. See
  [`snapshot.md`](snapshot.md) and [`treasury.md`](treasury.md).

---

## Instruction: `execute` (SPL Transfer Hook Interface)

### Parameters

```rust
amount: u64
```

### Discriminator

`[105, 37, 101, 197, 75, 251, 102, 26]` — first 8 bytes of
`sha256("spl-transfer-hook-interface:execute")`. Declared via
`#[instruction(discriminator = &[...])]`. Token-2022 uses this exact
discriminator when invoking the hook during `transfer_checked`.

### Accounts

Indexes 0–4 are fixed by the SPL interface. Indexes 5+ are whatever the
metalist declares, in the order above.

| Index | Account |
|---|---|
| 0 | `source_token` |
| 1 | `mint` |
| 2 | `destination_token` |
| 3 | `owner` |
| 4 | `extra_account_meta_list` |
| 5 | `deploy_program` |
| 6 | `asset_configuration_pda` |
| 7 | `factory_program` |
| 8 | `asset_class_version_pda` |
| 9 | `instructions_sysvar` |

### Execution

The hook reads the `Instructions` sysvar to know which top-level instruction
is being processed. The sysvar exposes only top-level instructions, so the
checks effectively gate the *outer* transaction shape.

1. Read `current_idx` via `load_current_index_checked(&instructions_sysvar)`.
   - Failure → `InstructionsSysvarUnreadable`.
   - `current_idx == 0` → `NoPreviousInstruction` (no slot before the transfer).
2. Build `ExpectedTransfer { source: source_token.key(), mint: mint.key(),
   destination: destination_token.key(), amount }`.
3. Load `prev_ix = instruction[current_idx - 1]` and `curr_ix = instruction[current_idx]`.
4. **Previous instruction must belong to `transfer`:**
   `prev_ix.program_id == TRANSFER_PROGRAM_ID` (else
   `PrevInstructionWrongProgram`). *Which* `transfer` instruction it has to be
   is decided by step 5 — the batch and single paths expect different ones.
5. **Dispatch on the current instruction's shape.** N is what tells the hook
   which pair it is looking at. It is the batch pair when
   `curr_ix.program_id == TRANSFER_PROGRAM_ID` and
   `curr_ix.data[0..8] == BATCH_TRANSFER_DISCRIMINATOR`; otherwise it is the
   single pair.
   - **Batch pair** (N-1 = `batch_verify_transfer`, N = `batch_transfer`).
     Because one batch fires the hook once per leg, neither instruction can be
     described by a single fixed triple — so instead the hook parses the Borsh
     `Vec<u64> amounts` (`[disc(8)][len: u32 LE][len × u64]`, length-validated
     against the data size) and requires the hooked
     `(source, destination, amount)` to appear as some leg `i` in **both**:
     - `batch_verify_transfer` (N-1): discriminator must be
       `BATCH_VERIFY_TRANSFER_DISCRIMINATOR` (else
       `PrevInstructionNotVerifyTransfer`); `source` @1, `mint` @2, and the
       `(destination, whitelist)` pairs as the trailing `2n` accounts → match
       `accounts[len-2n+2i] == destination && amounts[i] == amount`
       (else `PrevInstructionArgumentMismatch`).
     - `batch_transfer` (N): `source` @1, `mint` @2, destinations as the
       trailing `n` accounts → match `accounts[len-n+i] == destination &&
       amounts[i] == amount` (else `CurrentInstructionArgumentMismatch`).
     - **Pair identity** — the two must additionally describe the *same
       ordered* batch: identical `amounts` bytes (`data[8..]`) and identical
       destination order (N's trailing `n` vs the even offsets of N-1's
       trailing `2n`). Per-leg existence alone is not sufficient: without
       this, several transfer legs could collapse onto one verified leg, so
       `batch_verify_transfer`'s *summed* balance / partial-freeze check would
       cover less than what actually moves.

     Every executed leg is checked independently (the hook runs `n` times), so
     any leg not present in the verified batch reverts the whole transaction.
   In every non-batch case N-1 is checked against
   `VERIFY_TRANSFER_DISCRIMINATOR` (Anchor layout: 8-byte discriminator +
   `u64` amount; accounts 1/2/3 = source / destination / mint; errors
   `PrevInstructionNotVerifyTransfer` / `PrevInstructionArgumentMismatch`).
   N is then matched per entrypoint:

   - **`operations::controller_transfer`** — `curr_ix.program_id ==
     OPERATIONS_PROGRAM_ID`. N-1 is `verify_transfer` as above; N shares the
     same Anchor *data* layout but a different **account** layout —
     `controller_transfer` has no `source_owner` at index 0, so
     source / destination / mint sit at indices 4 / 5 / 3 rather than
     1 / 2 / 3. The two layouts are declared side by side as
     `TRANSFER_LAYOUT` / `CONTROLLER_TRANSFER_LAYOUT` in `execute.rs`;
     reordering the accounts of either introspected instruction requires
     updating its layout here.
   - **Bare `Token-2022::TransferChecked`** — `curr_ix.program_id ==
     TOKEN_2022_PROGRAM_ID`. N-1 is `verify_transfer` as above; N uses the SPL
     layout — 1-byte tag (`12`), 8-byte amount, 1-byte decimals; accounts at
     indices 0/1/2 = source / mint / destination (tag mismatch →
     `CurrentInstructionNotTransferOrTransferChecked`, accounts/amount →
     `CurrentInstructionArgumentMismatch`).
   - Else → `CurrentInstructionUnknownProgram`.
6. `require_functionality(asset_class_version_pda, TRANSFER_HOOK_EXECUTE)` —
   the asset-class version this mint is pinned to must have the hook's
   execute bit enabled.

Then it returns. The hook performs no CPI and mutates no account, so it adds
nothing to the transfer's write set beyond what Token-2022 itself touches.

Source ownership is intentionally **not** re-checked here: Token-2022's
`transfer_checked` enforces `source.owner == authority` before invoking the
hook.

---

## Why the double introspection (and not just N-1)

Restricting the legal entrypoints at index N (in addition to checking N-1)
closes a wrapper-attack hole that pure "previous = verify_transfer" leaves
open: a third-party program could otherwise sit at top level, internally call
`verify_transfer` via CPI, mutate state, then CPI into the transfer — all
hidden inside one top-level instruction. The `Instructions` sysvar only
exposes *top-level* instructions, so the hook would only see "the wrapper" at
N and "verify_transfer" at N-1 (signed earlier by the user) and let the
transfer through despite arbitrary state mutations between the verify and
the actual transfer. Forcing N to be exactly one of the three whitelisted
entrypoints (`transfer::batch_transfer`, `operations::controller_transfer`, bare
`Token-2022::TransferChecked`) denies any wrapper from sitting between the user
and the real transfer instruction.

`transfer::batch_transfer` needs one guarantee the single-leg entrypoints get for
free. Its paired `batch_verify_transfer` checks the *sum* of the legs against
the source's unfrozen balance, so matching each hooked leg against *some* leg
of the verified batch is not enough — two transfer legs of 100 could both point
at a single verified leg of 100, moving 200 against a 100-token check. Hence
the pair-identity check in step 5: same amounts, same order, same destinations.

`operations::controller_transfer` is on that list because a controller
force-transfer is itself a top-level, fully-gated entrypoint (controller role +
`OPERATIONS_CONTROLLER_TRANSFER` functionality), just with a different authority
than a holder-initiated transfer. It is not a wrapper: the hook pins its
discriminator, so nothing else in `operations` can reach the transfer path.

The bare `Token-2022::TransferChecked` entrypoint is permitted for
composability, and since the mint no longer carries `DefaultAccountState(Frozen)`
it is a genuinely usable path rather than the dead letter it used to be. Token
accounts now start `Initialized`, so nothing rejects a direct top-level
`transfer_checked` before the hook runs.

This does **not** weaken compliance. The gate has always been the
double-introspection check, not the account state: a bare `transfer_checked` still
only succeeds if the immediately-prior top-level instruction is
`transfer::verify_transfer` with matching `source` / `destination` / `mint` /
`amount`, and that `verify_transfer` runs the full rule set (deactivation,
transfer mode, whitelist, frozen-account marker, unfrozen balance). What was
removed is a redundant belt-and-braces layer, not a rule. Callers composing on
this path must therefore still prepend their own `verify_transfer`.

---

## Error Codes

```rust
pub enum TransferHookError {
    InvalidAccountSize,                           // ExtraAccountMetaList size mismatch during init

    // Introspection — structural
    InstructionsSysvarUnreadable,                 // sysvar load syscall failed
    NoPreviousInstruction,                        // current_idx == 0

    // Introspection — previous instruction (must be verify_transfer)
    PrevInstructionWrongProgram,                  // not transfer
    PrevInstructionNotVerifyTransfer,             // discriminator mismatch
    PrevInstructionArgumentMismatch,              // amount / source / destination / mint / data layout

    // Introspection — current instruction (must be transfer, batch_transfer, controller_transfer or transfer_checked)
    CurrentInstructionUnknownProgram,             // not transfer, operations or token-2022
    CurrentInstructionNotTransferOrTransferChecked, // wrong discriminator/tag
    CurrentInstructionArgumentMismatch,
}
```

---

## Program IDs

All program IDs are imported from `common::program_ids`:

```rust
use common::program_ids as constants;
// constants::DEPLOY_PROGRAM_ID, constants::TRANSFER_PROGRAM_ID, etc.
```

## constants.rs

`transfer-hook` is the only program that still has a `constants.rs`. It contains only instruction discriminators — not program IDs:

```rust
// Anchor / SPL discriminators — used by the introspection check against
// the data of the introspected instructions. Must be kept in sync with
// transfer's and operations' #[program] (Anchor derives them from the Rust
// function names sha256("global:<name>")[..8]).
pub const VERIFY_TRANSFER_DISCRIMINATOR:       [u8; 8] = [...];
pub const TRANSFER_DISCRIMINATOR:              [u8; 8] = [...];
pub const BATCH_VERIFY_TRANSFER_DISCRIMINATOR: [u8; 8] = [...];
pub const BATCH_TRANSFER_DISCRIMINATOR:        [u8; 8] = [...];
pub const CONTROLLER_TRANSFER_DISCRIMINATOR:   [u8; 8] = [...];
pub const TOKEN_2022_TRANSFER_CHECKED_TAG:     u8      = 12;
```
