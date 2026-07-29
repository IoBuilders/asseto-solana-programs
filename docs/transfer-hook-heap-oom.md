# Transfer-hook compliance and the Token-2022 32 KiB heap

## Table of contents

- [TL;DR](#tldr)
- [What the hook checks](#what-the-hook-checks)
- [The 32 KiB heap: why it bounds the metalist](#the-32-kib-heap-why-it-bounds-the-metalist)
- [History: why the design changed](#history-why-the-design-changed)

## TL;DR

All CMTAT transfer compliance runs inside `transfer-hook::execute`, which
Token-2022 invokes during every `transfer_checked`. The hook reads accounts and
**writes nothing**. The client contract is a single `transfer::transfer` /
`transfer::batch_transfer` instruction — see [`docs/transfer.md`](transfer.md).

The `ExtraAccountMetaList` carries ~13 entries and resolves comfortably within
Token-2022's 32 KiB heap on the current `spl-token-2022`. **The binding
constraint is compute units, not heap**: the unblock → `transfer_checked` →
hook → block chain needs ~400 K CU (scaled per batch leg), so callers set an
explicit `ComputeBudgetProgram.setComputeUnitLimit`. If a future extension ever
grows the metalist enough to OOM again, the durable fix is **Token ACL
(sRFC-37)**, not a bigger heap (see below).

## What the hook checks

`transfer-hook::execute` enforces, in order:

1. `require_transferring` — assert we are genuinely inside a Token-2022 transfer
   (the account's `transferring` flag is set). Applies to everyone, including
   the controller path below.
2. **Controller bypass** — if the transfer authority is the
   `["permanent_delegate", mint]` PDA (an `operations::controller_transfer`
   seizure), return early and skip all remaining compliance. Only `operations`
   can sign that PDA via `invoke_signed`, and Token-2022 validates the authority
   signed before calling the hook, so a normal holder cannot reach this path.
3. `require_active` — mint not deactivated.
4. `verify_transfer_control_mode` — transfer-mode / whitelist.
5. `require_unfrozen_account` — source not fully frozen.
6. `require_frozen_balance_covered` — the hook runs *after* Token-2022 debits
   the source, so the pre-debit `available >= amount` rule is restated for the
   post-debit balance as `balance_post >= frozen`.
7. `require_functionality(TRANSFER_HOOK_EXECUTE)` — the functionality is enabled
   for the mint's asset-class version.

Any failing check returns an `Err`, which aborts the whole `transfer_checked`
(and the transaction). See [`docs/transfer-hook.md`](transfer-hook.md) for the
account struct and the full metalist contents.

## The 32 KiB heap: why it bounds the metalist

Token-2022 resolves the entire `ExtraAccountMetaList` **before** invoking the
hook — TLV-decoding the PDA, running `find_program_address` for every
seed-based entry, and building the CPI's account vectors. All of that runs on
Token-2022's heap, which is **hard-coded to 32 KiB**:

```rust
pub const HEAP_LENGTH: usize = 32 * 1024;   // solana-program-entrypoint, compile-time

#[global_allocator]
static A: BumpAllocator = BumpAllocator { start: HEAP_START_ADDRESS as usize, len: HEAP_LENGTH };
```

`ComputeBudgetProgram.requestHeapFrame(bytes)` does **not** lift this. The
runtime maps the larger region, but Token-2022's bump allocator was compiled
believing it only has 32 KiB and never looks past that boundary:

```rust
if pos < self.start + size_of::<*mut u8>() {  // self.start + 32 KiB
    return null_mut();                         // → "out of memory"
}
```

`spl-token-2022` neither enables the `custom-heap` feature nor ships a custom
allocator, and it is an already-deployed binary we cannot recompile. So from our
side the 32 KiB cap is fixed: **if the metalist ever grows large enough to
exhaust it, only the SPL maintainers can raise the cap.** A metalist that OOMs
fails inside Token-2022, before the hook runs — no hook log line ever appears.

