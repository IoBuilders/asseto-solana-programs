---
name: write-tests
description: Use when writing tests in the cmtat-one-atelier-poc workspace — either adding a new test case to an existing `tests/cmtat-XXXX.ts` file or (rarer) scaffolding a new test file for a program. Triggers on "add a test for cmtat-X", "write a test for the Y instruction", "cover Z with a test", "create the test file for W". Covers: the `deployMint()` / `mintTokens()` helper shape, program workspace references, Anchor-0.32 `as Program<any>` workaround, the `AnchorError` vs `SendTransactionError` decision (the subtle part), shared helpers (`snapshotAccounts`, `transferSnapshotAccounts`, `fundTransferHookAuthority`), pre-instructions for transfer tests, and running a single suite.
---

# Writing Tests

## Start by reading a sibling

Before writing anything, open one or two existing `tests/cmtat-<x>.ts` files and scan them. This skill captures *why* the patterns look the way they do; the sibling file shows the current exact shape. `cmtat-pause.ts` is the simplest happy-path+error pattern to copy from; `cmtat-transfer.ts` is the most comprehensive (hook, snapshots, pre-instructions).

## 1. Run a single suite

```bash
TEST_FILE=cmtat-<name> anchor test --skip-build
```

`TEST_FILE` is the filename under `tests/` without `.ts`. Leaving it unset runs every suite. Use `--skip-build` once you've done a fresh `anchor build`.

## 2. `describe` structure

Every test file has exactly one top-level `describe("cmtat-<name>", ...)` block. Program workspace references, helper functions, and `it()` cases all live inside it. The provider is set up at the top:

```ts
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
```

## 3. Program references — use `as Program<any>`

Anchor 0.32's strict `ResolvedAccounts` typing rejects calls that pass `mintOwnerPda` (and other PDAs) by hand, so every workspace program except the one whose IDL we fully trust is cast to `any`:

```ts
const pauseProgram = anchor.workspace.CmtatPause as Program<any>;
```

The cast is deliberate — don't fight the types. The only program you'd keep as `Program<CmtatX>` is the one whose accounts map is small enough to satisfy the strict types (often `cmtat-deploy` in the helper that calls `deploy_mint`).

## 4. `deployMint()` helper (if the file doesn't exist yet)

Every test file has a local `deployMint()` helper that:
1. Generates a fresh mint keypair.
2. Derives every authority PDA and `extra_account_meta_list` via `PublicKey.findProgramAddressSync`.
3. Calls `deployProgram.methods.deployMint({...}).accounts({...}).signers([mintKeypair]).rpc(...)`.
4. Returns only the PDAs the current file's tests actually need.

Don't try to share it across files via `import` — tests need a fresh mint per case and each file's returned tuple is tailored to what it exercises. Copy-paste from the closest sibling and trim the return shape.

If the program needs tokens in some tests, add a `mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, amount)` helper that creates a token account with `createAccount(...)` from `@solana/spl-token`, then calls `mintProgram.methods.mint(amount)...`. `cmtat-transfer.ts` and `cmtat-operations.ts` have the reference implementation; the correct set of snapshot accounts comes from the `snapshotAccounts()` helper below.

## 5. Snapshot helpers

For any program that moves tokens (mint / burn / transfer), declare these once per file:

```ts
function snapshotAccounts(mint: PublicKey, holderTokenAccount: PublicKey) {
  const [snapshotCounterPda]    = PublicKey.findProgramAddressSync([Buffer.from("snapshot_counter"),       mint.toBuffer()], snapshotProgram.programId);
  const [totalSupplySnapshot]   = PublicKey.findProgramAddressSync([Buffer.from("snapshot_totalsupply"),   mint.toBuffer()], snapshotProgram.programId);
  const [holderBalanceSnapshot] = PublicKey.findProgramAddressSync([Buffer.from("snapshot_holderbalance"), mint.toBuffer(), holderTokenAccount.toBuffer()], snapshotProgram.programId);
  return { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot };
}
```

For transfer tests, the hook needs both parties' holder-balance snapshot PDAs:

```ts
function transferSnapshotAccounts(mint, source, destination) {
  // same idea, returns { snapshotCounterPda, senderSnapshot, receiverSnapshot }
}
```

These are passed through to the instruction's account map as `snapshotCounterPda`, `totalSupplySnapshot`, `holderBalanceSnapshot` (mint/burn) or `snapshotCounterPda`, `senderSnapshot`, `receiverSnapshot` (transfer).

To assert snapshot values, prefer the `get_*_snapshot_at(snapshot_id)` views via `.view()`:

```ts
const value: anchor.BN = await (snapshotProgram as any).methods
  .getHolderbalanceSnapshotAt(new anchor.BN(1))
  .accounts({ mint, holderBalanceSnapshot, holderTokenAccount })
  .view();
```

## 6. Transfer-specific patterns

Transfer tests need two extra bits of setup:

### Fund the transfer-hook authority

The hook authority PDA pays for snapshot-PDA creation inside `execute`, so it must hold lamports before any transfer. Once per test, call a local helper:

```ts
async function fundTransferHookAuthority(transferHookAuthority: PublicKey) {
  await anchor.web3.sendAndConfirmTransaction(
    connection,
    new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payerKeypair.publicKey,
        toPubkey:   transferHookAuthority,
        lamports:   anchor.web3.LAMPORTS_PER_SOL * 0.01,
      })
    ),
    [payerKeypair],
    { commitment: "confirmed" }
  );
}
```

### Pre-instructions on every `transfer(...)` call

```ts
.preInstructions([
  anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  anchor.web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
])
```

Both are required on transfer tests — the CU limit because the hook CPI chain is heavy, the heap frame because the metalist resolution path requires more room than the default 32 KiB.

## 7. Assertion style — `AnchorError` vs `SendTransactionError`

This is the part that most often breaks a test. Pick the right one based on **where the error is raised**:

| Where the error comes from | Caught as | How to assert |
|---|---|---|
| Directly in the instruction you called (`cmtat-pause::pause`, `cmtat-mint::mint`, etc.) | `AnchorError` | `assert.instanceOf(err, AnchorError)` then `anchorErr.error.errorCode.code === "Deactivated"` |
| Inside a sibling program reached via Anchor CPI (e.g. `require_active` in the instruction you called) | `AnchorError` — Anchor parses it from logs | same as above |
| Inside `cmtat-transfer-hook::execute` invoked by Token-2022 | `SendTransactionError` — Anchor can't parse the error from that depth | either `assert.instanceOf(err, SendTransactionError)` + `logs.some(l => l.includes("<substring>"))`, **or** `AnchorError.parse(sendErr.logs)` then assert on the returned code |
| Token-2022 native error (e.g. owner mismatch, mint paused, insufficient funds) | `SendTransactionError` | inspect `(err as SendTransactionError).logs` for a Token-2022-specific substring like `"owner does not match"` or `"paused"` |

Canonical templates:

```ts
// Direct-program AnchorError
try {
  await program.methods.x().accounts({...}).rpc(...);
  assert.fail("Expected Deactivated error but instruction succeeded");
} catch (err) {
  assert.instanceOf(err, AnchorError);
  assert.equal((err as AnchorError).error.errorCode.code, "Deactivated");
}

// Deep-CPI or Token-2022 error
try {
  await program.methods.x().accounts({...}).preInstructions([...]).rpc(...);
  assert.fail("Expected failure but instruction succeeded");
} catch (err) {
  assert.instanceOf(err, SendTransactionError);
  const logs = (err as SendTransactionError).logs ?? [];
  assert.isTrue(logs.some(l => l.toLowerCase().includes("<expected substring>")));
}
```

## 8. `it()` shape

One happy-path `it()` per instruction, then one `it()` per precondition error. Every test starts with a fresh `deployMint()` (and, if needed, fresh mint tokens) so tests don't leak state.

```ts
it("<instruction>: <expected behaviour>", async () => {
  const { mint, mintOwnerPda, ... } = await deployMint();
  // arrange: derive PDAs, create token accounts, set any extra state
  // act: call the instruction
  // assert: read state, compare balances, etc.
});
```

## 9. Silence noise

`tests/setup.ts` wipes `console.log` by default (`VERBOSE = false`). Don't `require` it in individual files — mocha picks it up via the `--require tests/setup.ts` flag in the `[scripts] test` line of `Anchor.toml`. Use `console.log` freely in tests; when debugging, flip `VERBOSE = true` in `setup.ts`.

## 10. Don't duplicate setup in `beforeEach`

The existing tests deliberately call `deployMint()` inside each `it()` rather than a shared `beforeEach`, so individual failures leave no state behind. Keep that pattern — it's verbose but makes tests independently reproducible.
