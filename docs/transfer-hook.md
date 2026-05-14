# transfer-hook — Program Reference

Program ID: `2qjsucJfrjP93FCwnYjc9EjYzYS8u31eWHhQo1jR9pcg`

Implements the [SPL Transfer Hook Interface](https://spl.solana.com/transfer-hook-interface).
Token-2022 invokes `execute` automatically on every `transfer_checked` call
for mints that have this program registered in their `TransferHook` extension.

Two responsibilities:

1. **Introspection gate.** Reads the `Instructions` sysvar and refuses the
   transfer unless (a) the immediately-prior top-level instruction is
   `transfer::verify_transfer` with matching arguments and (b) the
   current top-level instruction is one of two known-good entrypoints
   (`transfer::transfer` or a bare top-level
   `Token-2022::TransferChecked`) — also with matching arguments. This is
   the only compliance enforcement the hook does; the actual rule checks
   (deactivation, transfer-mode, whitelist, frozen account, frozen balance)
   live in `transfer::verify_transfer` so the metalist stays small
   enough for Token-2022's 32 KiB heap to resolve it (see
   [`transfer-hook-heap-oom.md`](transfer-hook-heap-oom.md)).
2. **Snapshots.** Calls `snapshot::update_holderbalance_snapshot`
   twice — once for the sender, once for the receiver — recording
   pre-transfer balances into whatever snapshot is currently active.

Owns two mint-scoped PDAs: `["transfer_hook_authority", mint]` (the Token-2022
extension authority; also the payer + calling-authority for the snapshot CPIs)
and `["extra-account-metas", mint]` (the SPL `ExtraAccountMetaList`).

---

## PDAs

| Seeds | Purpose |
|---|---|
| `["transfer_hook_authority", mint]` | Token-2022 TransferHook extension authority; payer for snapshot PDAs; signer for snapshot CPIs |
| `["extra-account-metas", mint]` | SPL `ExtraAccountMetaList` — declares which extra accounts Token-2022 forwards to `execute` |

---

## Instruction: `initialize_extra_account_meta_list` (Auxiliary)

### Parameters

```rust
deployer: Pubkey  // retained for ABI stability with deploy; no longer used
                  // (clearing-mode signer enforcement moved to verify_transfer)
```

Creates and populates the `ExtraAccountMetaList` PDA. Called exclusively via
CPI from `deploy::deploy_mint`, authorised by requiring `mint_owner_pda`
as `Signer` — only `deploy` can produce that signature.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Funds rent |
| `mint_owner_pda` | no | yes | UncheckedAccount | Signer proves the call originates from `deploy_mint`; seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID` |
| `extra_account_meta_list` | yes | no | AccountInfo | init; seeds `["extra-account-metas", mint]`; size = `ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_META_COUNT)` (currently 7) |
| `mint` | no | no | UncheckedAccount | Seed component and PDA-precompute input |
| `system_program` | no | no | Program<System> | |
| `rent` | no | no | Sysvar<Rent> | |

### Metalist contents

The metalist now lists only the accounts the hook still needs after the move
of compliance checks into `transfer::verify_transfer`. Keeping it small
is what lets Token-2022 fit metalist resolution into its 32 KiB heap.

| Hook idx | Entry | Kind |
|---|---|---|
| 5 | `snapshot` program | literal pubkey |
| 6 | `snapshot_counter_pda` | external PDA via @5 — seeds `["snapshot_counter", mint@1]` |
| 7 | `sender_snapshot` (writable) | external PDA via @5 — seeds `["snapshot_holderbalance", mint@1, source@0]` |
| 8 | `receiver_snapshot` (writable) | external PDA via @5 — seeds `["snapshot_holderbalance", mint@1, destination@2]` |
| 9 | `transfer_hook_authority` (writable) | this-program PDA — seeds `["transfer_hook_authority", mint@1]` |
| 10 | system program | literal pubkey |
| 11 | Instructions sysvar | literal pubkey (`Sysvar1nstructions...`) — required by the introspection check |

The 10 compliance entries that lived here before commit `7d417c2`'s heap-OOM
incident (`mint_owner_pda`, `deactivate_pda`, `deployer`,
`transfer_control_mode_pda`, `transfer-control` program, source/destination
whitelist PDAs, `freeze` program, `source_frozen_pda`,
`source_frozen_balance_pda`) are gone — `verify_transfer` consumes them
directly at the top level instead.

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
| 5 | `snapshot_program` |
| 6 | `snapshot_counter_pda` |
| 7 | `sender_snapshot` |
| 8 | `receiver_snapshot` |
| 9 | `transfer_hook_authority` |
| 10 | `system_program` |
| 11 | `instructions_sysvar` |

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
4. **Previous-instruction check (must be `transfer::verify_transfer`):**
   - `prev_ix.program_id == TRANSFER_PROGRAM_ID` (else `PrevInstructionWrongProgram`).
   - `prev_ix.data[0..8] == VERIFY_TRANSFER_DISCRIMINATOR`
     (else `PrevInstructionNotVerifyTransfer`).
   - `prev_ix.data[8..16]` parsed as little-endian `u64` equals `expected.amount`,
     and `prev_ix.accounts[1..=3]` equal `expected.source / destination / mint`
     (any mismatch → `PrevInstructionArgumentMismatch`).
5. **Current-instruction check (must be `transfer::transfer` OR
   `Token-2022::TransferChecked`):**
   - If `curr_ix.program_id == TRANSFER_PROGRAM_ID`: same Anchor layout
     check as step 4 but against `TRANSFER_DISCRIMINATOR` and using the
     `Current*` error variants.
   - Else if `curr_ix.program_id == TOKEN_2022_PROGRAM_ID`: SPL layout —
     1-byte tag (`12`), 8-byte amount, 1-byte decimals; accounts at
     indices 0/1/2 = source / mint / destination (any mismatch →
     `CurrentInstructionNotTransferOrTransferChecked` for tag,
     `CurrentInstructionArgumentMismatch` for accounts/amount).
   - Else → `CurrentInstructionUnknownProgram`.
6. CPI → `snapshot::update_holderbalance_snapshot(amount, /*increase=*/ true)`
   signed with `["transfer_hook_authority", mint, bump]`, targeting
   `sender_snapshot` + `source_token`. `amount` is added back so the recorded
   value is the pre-transfer sender balance (Token-2022 has already debited
   the source by this point).
7. CPI → `snapshot::update_holderbalance_snapshot(amount, /*increase=*/ false)`
   signed with the same seeds, targeting `receiver_snapshot` +
   `destination_token`. `amount` is subtracted so the recorded value is the
   pre-transfer receiver balance.

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
the actual transfer. Forcing N to be exactly `transfer::transfer` (or a
bare top-level `Token-2022::TransferChecked`) denies any wrapper from sitting
between the user and the real transfer instruction.

The bare `Token-2022::TransferChecked` entrypoint is permitted for
composability but is effectively dead-letter today: the source account is
`DefaultAccountState::Frozen`, and only `freeze::unblock_account` (which
only `transfer::transfer` invokes) can thaw it. A direct top-level
`transfer_checked` therefore fails at Token-2022's frozen-account check
before the hook ever runs.

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

    // Introspection — current instruction (must be transfer or transfer_checked)
    CurrentInstructionUnknownProgram,             // not transfer and not token-2022
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
// transfer's #[program] (Anchor derives them from the Rust function
// names sha256("global:<name>")[..8]).
pub const VERIFY_TRANSFER_DISCRIMINATOR:    [u8; 8] = [...];
pub const TRANSFER_DISCRIMINATOR:           [u8; 8] = [...];
pub const TOKEN_2022_TRANSFER_CHECKED_TAG:  u8       = 12;
```
