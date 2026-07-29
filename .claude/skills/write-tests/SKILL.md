---
name: write-tests
description: Use when writing tests in the asseto-solana-programs workspace — either adding a new test case to an existing `tests/<name>.ts` file or (rarer) scaffolding a new test file for a program. Triggers on "add a test for X", "write a test for the Y instruction", "cover Z with a test", "create the test file for W". Covers: the helper shape in program_helpers/, how program clients are typed and accessed, the `AnchorError` vs `SendTransactionError` decision (the subtle part), the transfer helpers and their hook accounts, and running a single suite or single test.
---

# Writing Tests

## Start by reading a sibling

Before writing anything, open one or two existing `tests/<x>.ts` files and scan them. This skill captures *why* the patterns look the way they do; the sibling file shows the current exact shape. `pause.ts` is the simplest happy-path+error pattern to copy from; `transfer.ts` is the most comprehensive (hook-enforced compliance, planted state, batch remaining accounts).

## 1. Run a single suite or test

```bash
# Run all tests in one file
TEST_FILE=<name> anchor test --skip-build

# Run a single test by name inside a file
TEST_FILE=<name> GREP="<partial test name>" anchor test --skip-build
```

`TEST_FILE` is the filename under `tests/` without `.ts`. `GREP` is matched against the full test title (`describe` + `it` concatenated). Use `--skip-build` once you've done a fresh `anchor build`.

## 2. `describe` structure

Every test file has exactly one top-level `describe("<name>", ...)` block. Program workspace references, helper functions, and `it()` cases all live inside it. The provider is set up at the top:

```ts
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const deployer = provider.wallet.publicKey;
const payerKeypair = provider.wallet.payer!;
```

## 3. Program references live in helpers, not in test files

Test files (`tests/*.ts`) don't access `anchor.workspace` directly. All program clients are instantiated inside the corresponding `program_helpers/` file, typed with the generated IDL type:

```ts
// inside pause_helper.ts
function getPauseProgram(): Program<Pause> {
  return anchor.workspace.Pause as Program<Pause>;
}
```

Test files only call the exported helper functions — they never touch `anchor.workspace` themselves. If you're writing a new helper, follow this pattern: one private getter per program, fully typed.

## 4. Helper files under `tests/program_helpers/`

All shared test logic lives here. Import from the relevant helper rather than re-implementing inline.

| File | Key exports |
|---|---|
| `base_helper.ts` | Context type hierarchy (`DeployerContext`, `MintWriteContext`, etc.) |
| `deploy_helper.ts` | `deployMint(context, args?)` |
| `mint_helper.ts` | `mintTokens(context, args?)` |
| `spl_token_helper.ts` | `createTokenAccount`, `getTokenAccount`, `getMint`, `createMint`, `mintTo` |
| `transfer_helper.ts` | `splTransfer(context, args?)`, `buildSplTransferCheckedInstruction(...)`, `batchTransfer(context, args?)` |
| `freeze_helper.ts` | `freezeAccount`, `unfreezeAccount`, `partiallyFreezeAccount`, `removePartialFreeze` |
| `pause_helper.ts` | `pauseMint`, `unpauseMint` |
| `deactivate_helper.ts` | `deactivateMint` |
| `snapshot_helper.ts` | `takeSnapshot` |
| `coupon_helper.ts` | `createCoupon` |
| `bond_helper.ts` | `updateBondTerms` |
| `account_helper.ts` | `requestAirdrop`, `getAccountInfo`, `getBalanceForRentExeption` |

### Context type hierarchy (from `base_helper.ts`)

```ts
type BaseWriteContext   = { signers?: Signer[] };
type DeployerContext    = BaseWriteContext & { deployer: PublicKey };
type MintContext        = { mint: PublicKey };
type MintWriteContext   = DeployerContext & MintContext;
```

Helpers compose these types. When calling a helper, pass an object that satisfies the context.

## 5. `deployMint()` — shared helper, not local

`deployMint` lives in `deploy_helper.ts`. Import it; don't re-implement it per file.

```ts
import { deployMint } from "./program_helpers/deploy_helper";

const { mint } = await deployMint({ deployer }, { decimals: 6 });
```

Options object (all optional, with defaults):

```ts
type DeployMintArgs = {
  decimals?: number;               // default: 6
  name?: string;                   // default: "Test Token"
  symbol?: string;                 // default: "TEST_TOKEN"
  uri?: string;                    // default: "https://example.com/metadata.json"
  additionalMetadata?: { key: string; value: string }[];  // default: []
};
```

## 6. `mintTokens()` — minting bond/asset tokens to an account

```ts
import { mintTokens } from "./program_helpers/mint_helper";

await mintTokens(
  { deployer, mint, destination: holderTokenAccount },
  { amount: new anchor.BN(1_000_000) }
);
```

`amount` defaults to `new anchor.BN(1)` if omitted. Returns `void`.

## 7. SPL token and account helpers — no `provider` argument

All functions in `spl_token_helper.ts` and `account_helper.ts` obtain the provider internally via `anchor.getProvider()`. Do not pass `provider` at the call site.

```ts
import {
  createTokenAccount,
  getTokenAccount,
  getMint,
  createMint,
  mintTo,
} from "./program_helpers/spl_token_helper";
import {
  requestAirdrop,
  getAccountInfo,
  getBalanceForRentExeption,
} from "./program_helpers/account_helper";

// Create a Token-2022 token account
const ta = await createTokenAccount({ mint, owner: deployer });

// Read a token account
const account = await getTokenAccount(tokenAccountPubkey);

// Read mint info
const mintInfo = await getMint(mint);

// Create a stand-alone Token-2022 mint (e.g. payment mint for treasury tests)
const paymentMint = await createMint({ decimals: 6 });

// Mint raw tokens (bypassing the Anchor mint instruction)
await mintTo({ mint, tokenAccount: ta, amount: BigInt(1_000_000) });

// Airdrop SOL to a keypair
await requestAirdrop(rogueKeypair.publicKey);

// Check if an account exists
const info = await getAccountInfo(somePda);
```

All SPL helpers default to `TOKEN_2022_PROGRAM_ID` and `{ commitment: "confirmed" }` — no need to pass those.

## 8. PDA derivation — use `pda_utils`

Derive PDAs via `tests/utils/pda_utils.ts` rather than inline `findProgramAddressSync`:

```ts
import * as pdaUtils from "./utils/pda_utils";

const assetConfigurationPda = pdaUtils.assetConfigurationPda(mint);
const treasuryAuthority      = pdaUtils.treasuryAuthorityPda(mint);
const snapshotCounterPda     = pdaUtils.snapshotCounterPda(mint);
// etc.
```

## 9. Role setup for Management-instruction tests

Every Management instruction is role-gated (`require_role`), so its happy-path test must grant the caller the right role first, and its error cases must include a `MissingRole` case:

```ts
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_PAUSER } from "./utils/roles"; // one ROLE_* constant per common::roles entry

beforeEach(async () => {
  ({ mint } = await deployMint({ deployer }));
  await setRoles(mint, authority.publicKey, [ROLE_PAUSER]);
});

it("pause: fails with MissingRole when authority doesn't have required role", async () => {
  await setRoles(mint, authority.publicKey, []); // revoke for this one test
  try {
    await pauseMint({ authority, mint });
    assert.fail("Expected MissingRole error but instruction succeeded");
  } catch (err) {
    assert.instanceOf(err, AnchorError);
    assert.equal((err as AnchorError).error.errorCode.code, "MissingRole");
  }
});
```

`tests/utils/roles.ts` mirrors `common::roles` — check there for the exact constant name before hardcoding a role id. If the instruction is also functionality-gated (see `docs/<program>.md`'s Preconditions section), also cover the `FunctionalityNotSupportedError` case by not enabling the relevant `functionalities` bit on the asset-class version.

## 10. Transfer-specific patterns

### Using `splTransfer()` from `transfer_helper.ts`

A transfer is a single instruction — Token-2022's own `transfer_checked` with the
transfer hook's 15 accounts appended. The helper builds and sends it, and raises the
compute budget:

```ts
import { splTransfer } from "./program_helpers/transfer_helper";

await splTransfer(
  { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
  { amount: TRANSFER_AMOUNT }
);
```

There is no verify pre-instruction to build or malform — all compliance runs inside
`transfer-hook::execute`, so error cases are set up by planting state (whitelist
marker, frozen PDA, deactivate marker) and then calling `splTransfer` normally. Use
`buildSplTransferCheckedInstruction` if a test needs the instruction rather than a
sent transaction, and `splTransferWithoutHookAccounts` for the "hook block omitted"
error case.

`batchTransfer()` covers `transfer::batch_transfer`; its `transferRemainingAccounts`
option overrides the per-leg `(destination, whitelistPda)` pairs for error paths.

### Compute budget on raw transfer calls

If you build a transfer instruction manually instead of using the helpers, attach:

```ts
.preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
```

Metalist resolution plus the hook's compliance suite does not fit the default 200 K CU.
Do **not** bother with `requestHeapFrame`: Token-2022's allocator is compiled against a
hard-coded 32 KiB heap and ignores it (see `docs/transfer-hook.md`).

## 11. Assertion style — `AnchorError` vs `SendTransactionError`

This is the part that most often breaks a test. Pick based on **where the error is raised**:

| Where the error comes from | Caught as | How to assert |
|---|---|---|
| Directly in the instruction you called | `AnchorError` | `assert.instanceOf(err, AnchorError)` → `err.error.errorCode.code === "SomeCode"` |
| Via Anchor CPI into a sibling program | `AnchorError` — Anchor parses it from logs | same |
| Inside `transfer-hook::execute` (Token-2022 invoked) | `AnchorError` when the call went through Anchor's `.rpc()` or a helper that re-parses the logs (`splTransfer`, `batchTransfer`) — otherwise `SendTransactionError` | assert the code as usual; for a raw `sendAndConfirm`, run `AnchorError.parse(sendErr.logs)` yourself |
| Token-2022 native error (owner mismatch, paused, etc.) | `SendTransactionError` | inspect `.logs` for Token-2022 substring |

Canonical templates:

```ts
// AnchorError — direct program error
try {
  await program.methods.x().accounts({...}).rpc({ commitment: "confirmed" });
  assert.fail("Expected error but instruction succeeded");
} catch (err) {
  assert.instanceOf(err, AnchorError);
  assert.equal((err as AnchorError).error.errorCode.code, "Deactivated");
}

// SendTransactionError — hook / Token-2022 / deep CPI
try {
  await program.methods.x().accounts({...}).rpc({ commitment: "confirmed" });
  assert.fail("Expected failure but instruction succeeded");
} catch (err) {
  assert.instanceOf(err, SendTransactionError);
  const logs = (err as SendTransactionError).logs ?? [];
  assert.isTrue(logs.some(l => l.includes("expected substring")));
}
```

## 12. `it()` shape

One happy-path `it()` per instruction, then one `it()` per precondition error. Every test starts with a fresh `deployMint()` so tests don't share state.

```ts
it("<instruction>: <expected behaviour>", async () => {
  const { mint } = await deployMint({ deployer }, { decimals: 6 });
  // arrange: derive PDAs, create token accounts, set state
  // act: call the instruction
  // assert: read state, compare balances
});
```

## 13. Silence noise

`tests/setup.ts` suppresses `console.log` by default. Mocha picks it up via `--require tests/setup.ts` in `Anchor.toml`. Use `console.log` freely in tests; flip `VERBOSE = true` in `setup.ts` when debugging.
