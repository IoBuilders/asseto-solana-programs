# cmtat-transfer-hook — Program Reference

Program ID: `482AUGU4SbYePPHaV7yvXrGEprHhiWSTRBds4Bdr6CPz`

Implements the [SPL Transfer Hook Interface](https://spl.solana.com/transfer-hook-interface). Token-2022 invokes `execute` automatically on every `transfer_checked` call for mints that have this program registered in their `TransferHook` extension.

Currently `execute` is a no-op (logs the amount). The infrastructure is in place to add custom logic (e.g., additional compliance checks) without modifying any other program.

---

## PDAs

| Seeds | Purpose |
|---|---|
| `["transfer_hook_authority", mint]` | Token-2022 TransferHook extension authority — set during `deploy_mint` |
| `["extra-account-metas", mint]` | SPL `ExtraAccountMetaList` — created during `deploy_mint` via CPI |

---

## Instruction: `initialize_extra_account_meta_list` (Auxiliary)

No parameters.

Creates and initializes the `ExtraAccountMetaList` PDA for the given mint. Called exclusively via CPI from `cmtat-deploy`'s `deploy_mint` (step 14).

Authorization is enforced by requiring `mint_owner_pda` as a `Signer`. Only `cmtat-deploy` can produce that signature via `invoke_signed` with seeds `["mint_owner", mint]`.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Funds the `ExtraAccountMetaList` account rent |
| `mint_owner_pda` | no | yes | UncheckedAccount | Signer proves the call comes from `deploy_mint`; seeds `["mint_owner", mint]`, `seeds::program = CMTAT_DEPLOY_PROGRAM_ID` |
| `extra_account_meta_list` | yes | no | AccountInfo | init; seeds `["extra-account-metas", mint]`; size = `ExtraAccountMetaList::size_of(0)` |
| `mint` | no | no | UncheckedAccount | Used as a seed component only |
| `system_program` | no | no | Program<System> | |
| `rent` | no | no | Sysvar<Rent> | |

### Execution

Calls `ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &[])` with an empty extra metas slice. The list currently stores 0 extra accounts — all 5 required accounts (source, mint, destination, owner, extra_account_meta_list) are fixed by the SPL interface.

---

## Instruction: `execute` (SPL Transfer Hook Interface)

### Parameters

```rust
amount: u64
```

### Discriminator

`[105, 37, 101, 197, 75, 251, 102, 26]` — first 8 bytes of `sha256("spl-transfer-hook-interface:execute")`.

This discriminator is declared via:
```rust
#[instruction(discriminator = &[105, 37, 101, 197, 75, 251, 102, 26])]
```

Token-2022 uses this exact discriminator when invoking the hook during `transfer_checked`.

### Accounts (fixed by SPL interface)

| Index | Account | Notes |
|---|---|---|
| 0 | `source_token` | Source token account |
| 1 | `mint` | The Token-2022 mint |
| 2 | `destination_token` | Destination token account |
| 3 | `owner` | Source account owner/authority |
| 4 | `extra_account_meta_list` | `ExtraAccountMetaList` PDA (validation state) |

Indexes 5+ are appended based on the `ExtraAccountMetaList`. Currently empty, so no additional accounts are passed.

### Execution

Currently a no-op: logs `"transfer-hook execute: amount={}"`. Custom compliance logic (e.g., checking additional PDAs) can be added here without modifying any other program.

---

## Adding Extra Accounts to the Hook

To pass additional accounts during `execute`:

1. Update `initialize_extra_account_meta_list` to push `ExtraAccountMeta` entries into the `metas` vec.
2. Update `Execute` accounts struct to include the new accounts.
3. Update the `execute` handler body with the new logic.
4. Redeploy `cmtat-transfer-hook` and re-initialize `extra_account_meta_list` (requires closing/re-creating the PDA or re-deploying the mint).

---

## constants.rs

```rust
// Sourced from crate — single source of truth.
pub use cmtat_deploy::ID as CMTAT_DEPLOY_PROGRAM_ID;
```
