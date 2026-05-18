# Transfer-hook OOM: why every CMTAT transfer fails after moving checks into the hook

## Table of contents

- [TL;DR](#tldr)
- [What the failure looks like](#what-the-failure-looks-like)
- [Sequence of events inside one failing transfer](#sequence-of-events-inside-one-failing-transfer)
- [Root cause: the on-chain heap is hard-coded to 32 KiB](#root-cause-the-on-chain-heap-is-hard-coded-to-32-kib)
  - [In one paragraph: who's actually doing the limiting](#in-one-paragraph-whos-actually-doing-the-limiting)
- [Why `requestHeapFrame(256 * 1024)` is in the test but does nothing](#why-requestheapframe256--1024-is-in-the-test-but-does-nothing)
- [Options to fix this](#options-to-fix-this)
- [Resolution: option 2 implemented](#resolution-option-2-implemented)

## TL;DR

Every test in `transfer` that actually invokes Token-2022's `transfer_checked`
now fails with:

```
Program log: Instruction: TransferChecked
Program log: Error: memory allocation failed, out of memory
Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: SBF program panicked
```

The OOM is raised **inside the Token-2022 program**, *before* our transfer-hook
code ever runs. Token-2022 has a hard-coded 32 KiB on-chain heap, and resolving
our 16-entry `ExtraAccountMetaList` to build the hook CPI now exhausts it.

`ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 })` does **not** help:
the SDK's default global allocator is a bump allocator with a hard-coded
`len = 32 * 1024`, and Token-2022 (which we cannot recompile) uses that default
allocator.

---

## What the failure looks like

From `anchor test --skip-build` (suite `transfer`), 6 of 8 transfer tests
now fail with the same root error. Representative log:

```
Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb success
Program 8L1kqDvAYC9dQXNNNnZbABtRbHGjzoxSgAPzbQZmwmSd consumed 14000 of 338133 compute units
Program 8L1kqDvAYC9dQXNNNnZbABtRbHGjzoxSgAPzbQZmwmSd success
Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]
Program log: Instruction: TransferChecked
Program log: Error: memory allocation failed, out of memory
Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb consumed 65799 of 317484 compute units
Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: SBF program panicked
Program Fa5VLqopKp6cokXJreYeNNmUG8F9AaE4CUBnGQvtdq7Q consumed 148015 of 399700 compute units
Program Fa5VLqopKp6cokXJreYeNNmUG8F9AaE4CUBnGQvtdq7Q failed: Program failed to complete
```

Two important facts to read out of this log:

1. The OOM and panic are emitted by `TokenzQ…` (Token-2022, program ID
   `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`), not by our hook program
   (`2qjsucJfrjP93FCwnYjc9EjYzYS8u31eWHhQo1jR9pcg`).
2. The very next log line after the OOM would have been
   `"Program 482AU… invoke [3]"` (the hook). That line never appears, so the
   hook code did not execute at all.

**Conclusion:** the failure is in Token-2022's *preparation* of the hook CPI,
not in our hook logic.

---

## Sequence of events inside one failing transfer

Top-level transaction (depth 1) is `transfer::transfer`. Inside it:

| Depth | Program                | Step                                        |
|-------|------------------------|---------------------------------------------|
| 2     | `freeze`         | `unblock_account(source)`                   |
| 3     | Token-2022             | `thaw_account` (CPI from `freeze`)    |
| 2     | `freeze`         | `unblock_account(destination)`              |
| 3     | Token-2022             | `thaw_account`                              |
| 2     | **Token-2022**         | **`transfer_checked` ← OOMs here**          |
| (3)   | *(`transfer-hook::execute` would be invoked here, but never is)* |

Inside `Token-2022::transfer_checked`, before the hook is invoked, the program
must:

1. Read and TLV-decode the `ExtraAccountMetaList` PDA (`["extra-account-metas", mint]`).
2. For each entry, resolve a target pubkey:
   - Literal pubkey entries → simply copy.
   - `Seed`-based entries → concatenate seed material (often via
     `Seed::AccountKey { index }` lookups), then `find_program_address` (which
     iterates SHA-256 with descending bumps).
3. Build a fresh `Instruction` containing the 4 base accounts +
   `ExtraAccountMetaList` PDA + every resolved extra account.
4. Build a fresh `Vec<AccountInfo>` matching that instruction.
5. `invoke` the hook program.

Steps 1–4 are all heap allocations (`Vec<u8>`, `Vec<AccountMeta>`,
`Vec<AccountInfo>`, plus per-PDA work in `find_program_address`). They all happen
on Token-2022's heap, **before** the hook runs.

This work is implemented in the SPL transfer-hook helper:

- [`spl-transfer-hook-interface-0.10.0/src/onchain.rs:15`](https://docs.rs/spl-transfer-hook-interface/0.10.0/src/spl_transfer_hook_interface/onchain.rs.html)
  `invoke_execute()` — builds the CPI instruction.
- `ExtraAccountMetaList::add_to_cpi_instruction()` (in `spl-tlv-account-resolution`) —
  iterates entries, resolves seeds, pushes new metas/infos.

---

## Root cause: the on-chain heap is hard-coded to 32 KiB

The Solana SDK's default entrypoint installs this global allocator
(`solana-program-entrypoint 2.3.0`,
[`src/lib.rs`](file:///home/alberto/.cargo/registry/src/index.crates.io-6f17d22bba15001f/solana-program-entrypoint-2.3.0/src/lib.rs)):

```rust
pub const HEAP_START_ADDRESS: u64 = 0x300000000;
pub const HEAP_LENGTH: usize       = 32 * 1024;          // ← 32 KiB, compile-time

#[global_allocator]
static A: BumpAllocator = BumpAllocator {
    start: HEAP_START_ADDRESS as usize,
    len:   HEAP_LENGTH,                                  // ← hard-coded
};
```

Two consequences:

1. **The 32 KiB cap is baked into the program binary.** Each SBF program
   invocation gets its own bump allocator instance with `len = 32 * 1024`.
2. **`requestHeapFrame` does *not* lift the cap for that allocator.**
   `ComputeBudgetProgram.requestHeapFrame(bytes)` asks the runtime to map a
   larger physical heap region at `HEAP_START_ADDRESS`, but the
   `BumpAllocator.alloc` check is against the hard-coded `len = 32 KiB`:

   ```rust
   pos = pos.saturating_sub(layout.size());
   pos &= !(layout.align().wrapping_sub(1));
   if pos < self.start + size_of::<*mut u8>() {  // self.start + 32 KiB
       return null_mut();                         // → "out of memory"
   }
   ```

   The extra mapped memory exists, but `alloc` refuses to use it.

To actually consume more than 32 KiB, a program has to opt in:

- enable the `custom-heap` feature on `solana-program-entrypoint`, AND
- declare its own `#[global_allocator]` that knows about the runtime-allocated
  heap size.

**`spl-token-2022` (v8.0.1) does not do either.** It is a third-party,
already-deployed binary that we cannot modify, so it is permanently capped at
32 KiB regardless of what we put in `requestHeapFrame`.

This is not a bug in our code — it is a Token-2022 / Solana-SDK limitation
that every transfer-hook author hits once their `ExtraAccountMetaList` grows
large enough.

### In one paragraph: who's actually doing the limiting

The picture is **not** "the runtime gives Token-2022 256 KiB and Token-2022
then chops it down to 32 KiB." It is: the runtime *does* give Token-2022 the
full 256 KiB of heap memory, but Token-2022's bump allocator was compiled
believing it only has 32 KiB and never looks past that boundary. The remaining
224 KiB of mapped memory just sits unused, because nothing in Token-2022's
code path ever dereferences it. That's also why we cannot fix this from our
side: lifting the cap would require rebuilding Token-2022 with a different
`HEAP_LENGTH` (or with the `custom-heap` feature plus a smarter allocator),
and only the SPL maintainers can ship a new Token-2022 binary.

---

## Why `requestHeapFrame(256 * 1024)` is in the test but does nothing

The tests already include:

```ts
.preInstructions([
  anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  anchor.web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
])
```

`setComputeUnitLimit` works (the OOM happens with plenty of CU left:
~252 K of 400 K still available when Token-2022 panics). `requestHeapFrame`
*does not work* for the reason above: Token-2022's allocator does not consult
it. Removing the `requestHeapFrame` line would not change the failure.

---

## Options to fix this

In rough order from "least invasive" to "most invasive":

1. **Move the compliance checks to `transfer`**, so the hook only needs the
   accounts required for the snapshot CPI:
   - snapshot program
   - `snapshot_counter` PDA
   - `sender_snapshot`, `receiver_snapshot` PDAs
   - `transfer_hook_authority` PDA
   - `system_program`

   That reduces the metalist to 6-entry size, which fits in
   32 KiB. The cost is that any caller invoking Token-2022's `transfer_checked`
   directly (without going through `transfer`) bypasses the compliance
   checks. Mitigation: keep the source account permanently frozen at the
   Token-2022 level (which `freeze`'s `DefaultAccountState::Frozen`
   already does), so any non-`transfer` path is rejected by Token-2022
   before reaching the hook at all. This is the cheapest path back to a
   working test suite.

2. **Use instruction introspection.** Expose a new `verify_transfer`
   instruction on `transfer` that runs
   the full compliance suite — deactivation, transfer-mode / whitelist /
   clearing, frozen account, frozen balance — without performing any token
   movement. Callers must place this instruction **immediately before** the
   `transfer_checked` instruction in the same transaction. The transfer hook
   then reads the `Instructions` sysvar and performs a **double introspection
   check**:

   - **`current_index - 1` is `verify_transfer`** with matching mint /
     source / destination / amount / authority arguments.
   - **`current_index` is `transfer.transfer`** (the only legitimate
     top-level entrypoint, since a direct top-level `Token-2022.transfer_checked`
     would always fail at the `DefaultAccountState::Frozen` check anyway)
     with arguments matching the transfer the hook is processing.

   The second check is what closes the wrapper-attack hole: without it, any
   third-party program could sit at `current_index`, run arbitrary
   state-mutating CPIs, then CPI into the transfer, and the hook would only
   see "previous top-level was `verify_transfer`" — true but useless,
   because the wrapper's mutations would have invalidated whatever
   `verify_transfer` checked. Requiring `current_index` to be exactly our
   own entrypoint forbids any wrapper from sitting between the user and the
   transfer.

   Once both checks pass, the hook only has to do the snapshot work, so the
   metalist collapses back to roughly 7 entries instead of 16.

   Disadvantages worth weighing:

   - **Mandatory transaction layout.** Every wallet, indexer, or integration
     that wants to move tokens has to assemble a 2-instruction batch in a
     fixed order. There is no way to do a "lone" `transfer_checked` and have
     it succeed — that would actually be the point — but it raises the
     integration bar for third parties who expected vanilla Token-2022
     ergonomics.
   - **Brittle to instruction reordering.** If a UI or aggregator inserts an
     unrelated instruction between `verify_transfer` and `transfer_checked`,
     or batches several transfers and reuses one `verify_transfer` call, the
     hook rejects it. The "previous instruction must be X" rule is strict by
     necessity.
   - **Argument-matching is security-critical and easy to get wrong.** The
     hook must compare the introspected instruction's accounts and data
     against the actual transfer it is hooking — same mint, same source,
     same destination, same amount, same authority. Loose matching opens a
     spoofing path: an attacker could call `verify_transfer` with benign
     arguments (say, a tiny amount, or a whitelisted destination) and then
     a different `transfer_checked` (large amount, non-whitelisted
     destination) in the next slot. Every comparison has to be exhaustive
     and well audited.
   - **TOCTOU window.** Solana executes instructions sequentially in a
     transaction, but any CPI inside `verify_transfer` or inside another
     instruction earlier in the transaction could mutate state (e.g., update
     the `frozen_balance` PDA) between the verification and the actual
     transfer. The check would then be stale. Today this is unlikely
     because only `freeze` writes those PDAs, but it is a class of
     bug to keep in mind as the codebase grows.
   - **Audit surface.** Introspection-based authorisation is a known
     foot-gun pattern. It needs careful documentation and tests
     (replay attempts, multi-transfer batches, CPI'd transfers) before it
     can be trusted in production.

---

## Resolution: option 2 implemented

The codebase now ships the introspection-based design (option 2 above), with
the **double-introspection** variant: the hook checks both `current_index - 1`
*and* `current_index` so a wrapper program cannot interpose between them.

What landed:

- A new top-level instruction `transfer::verify_transfer` runs the full
  CMTAT compliance suite (deactivation, transfer-mode dispatch / clearing /
  whitelist, frozen-account marker, frozen-balance) against the **pre-debit**
  state. No token movement. See
  [`transfer/src/instructions/verify_transfer.rs`](../programs/transfer/src/instructions/verify_transfer.rs).
- `transfer-hook::execute` now performs the double introspection check
  via the `Instructions` sysvar:
  - `current_index - 1` must be `transfer::verify_transfer` with
    matching `source` / `destination` / `mint` / `amount`.
  - `current_index` must be `transfer::transfer` *or*
    `Token-2022::TransferChecked`, also with matching args. (The bare
    `Token-2022::TransferChecked` entrypoint is allowed for composability but
    is effectively dead-letter today: `DefaultAccountState::Frozen` plus
    `freeze::unblock_account` access control mean only
    `transfer::transfer` can produce a successful transfer in practice.)
  - Failure raises one of nine granular error variants
    (`PrevInstructionWrongProgram`, `PrevInstructionNotVerifyTransfer`,
    `PrevInstructionArgumentMismatch`, `CurrentInstructionUnknownProgram`,
    `CurrentInstructionNotTransferOrTransferChecked`,
    `CurrentInstructionArgumentMismatch`, `NoPreviousInstruction`,
    `InstructionsSysvarUnreadable`) — each pinpointing exactly which check
    failed.
- The `ExtraAccountMetaList` shrank from 16 entries to 7. The 10 compliance
  PDAs/programs that used to be forwarded to the hook (`mint_owner_pda`,
  `deactivate_pda`, `deployer`, `transfer_control_mode_pda`,
  `transfer-control` program, source/destination whitelist PDAs,
  `freeze` program, `source_frozen_pda`, `source_frozen_balance_pda`)
  are gone — `verify_transfer` consumes them directly at the top level
  instead. The metalist now lists only what the hook still needs (snapshot
  program + counter + sender/receiver snapshot PDAs + transfer hook authority
  + system program + `Instructions` sysvar). With the metalist this small,
  Token-2022 fits its resolution work in the 32 KiB heap and the OOM
  documented at the top of this file no longer reproduces.

What clients have to do:

- Submit every transfer as **two adjacent top-level instructions in this
  order**:
  ```
  N-1:  transfer::verify_transfer(amount)
  N:    transfer::transfer(amount)
  ```
  Other instructions (e.g. ComputeBudget) are fine *before* `verify_transfer`,
  but nothing may sit between `verify_transfer` and `transfer`.
- The test suite [`tests/transfer.ts`](../tests/transfer.ts)
  encapsulates this in two helpers — `verifyTransferPdas(...)` and
  `buildVerifyTransferIx(source, destination, mint, amount, sourceOwnerOverride?, deployerOverride?)`
  — so each transfer test drops the result into `.preInstructions([...])`
  immediately before the `transfer` call.

Residual risk worth flagging in code review: the introspection layer can only
guarantee adjacency at top level. If a future change ever sneaks a
state-mutating CPI into `transfer::transfer` between its entry and the
inner `transfer_checked` (today the only CPIs there are `freeze`
unblock/block, which don't touch any of the PDAs `verify_transfer` reads),
the verification could silently go stale. Keep `transfer`'s body tight, and
document the invariant.
