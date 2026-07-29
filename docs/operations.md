# operations — Program Reference

Program ID: `BHDyg8PeUyVBpmkcjYLdnt3VCmYf4wp8Xeu6TXREiLKp`

Controls controller-driven token movements via the Token-2022 `PermanentDelegate` extension: burning (`burn`, `batch_burn`) and force-transfers (`controller_transfer`). Owns the `["permanent_delegate", mint]` PDA that was registered as the permanent delegate during `deploy_mint`. The permanent delegate can burn or transfer tokens from any token account without the account owner's consent.

This program also owns the `["permissioned_burn", mint]` PDA registered as the mint's `PermissionedBurn` authority during `deploy_mint`. That extension makes the plain Token-2022 `Burn` instruction unusable on these mints: burning must go through the extension's own `Burn`, which requires the permissioned-burn authority as an additional signer. Since only this program can sign for that PDA, `burn` and `batch_burn` below are the only way tokens of such a mint can ever be burned — the permanent delegate alone is not sufficient.

---

## Instruction: `burn` (Operational — controller only)

Burns `amount` tokens from any `token_account` for the given mint via the permanent delegate, without the holder's consent.

### Parameters

```rust
amount: u64  // raw token units to burn
```

### Preconditions

- `require_role(ROLE_CONTROLLER)` — the `authority` caller must sign and hold `ROLE_CONTROLLER` on this mint (checked against its own `["roles", mint, authority]` PDA). Replaces the previous `verify_deployer` gate — burning is now role-based rather than restricted to the deployer.
- `require_active` — mint must not be deactivated.
- `require_functionality(OPERATIONS_BURN)` — the mint's asset-class version must enable burning.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Required alongside `authority`; currently funds nothing in this instruction |
| `authority` | no | yes | Signer | The caller; must hold `ROLE_CONTROLLER` on this mint |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; the caller's own PDA, loaded and read by `require_role` (must exist & be owned by `access-control`) |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint to burn from |
| `token_account` | yes | no | UncheckedAccount | The holder's token account to burn from |
| `operations_authority` | no | no | UncheckedAccount | seeds `["permanent_delegate", mint]` (owned by this program); signs the burn CPI as the account's delegate |
| `permissioned_burn_authority` | no | no | UncheckedAccount | seeds `["permissioned_burn", mint]` (owned by this program); co-signs the burn CPI as the mint's `PermissionedBurn` authority |
| `token_2022_program` | no | no | Program<Token2022> | |
| `system_program` | no | no | Program<System> | |

### Execution

1. `require_role(authority_roles_pda.load()?, ROLE_CONTROLLER)` — signer must hold the controller role
2. `require_active(&deactivate_pda)` + `require_functionality(OPERATIONS_BURN)`
3. `invoke_signed` → `permissioned_burn::instruction::burn(token_account, mint, permissioned_burn_authority, operations_authority, amount)`, signed with **both** `["permanent_delegate", mint, bump]` and `["permissioned_burn", mint, bump]`

Both signatures are needed and neither is optional: `operations_authority` authorises debiting the account (as its permanent delegate), and `permissioned_burn_authority` satisfies the mint's `PermissionedBurn` extension. This is the extension's `Burn` variant, not the plain Token-2022 `Burn` — the plain one has no account slot for the permissioned-burn authority and is rejected outright on a mint carrying the extension.

---

## Instruction: `batch_burn` (Operational — controller only)

Burns, in a single instruction, `amounts[i]` tokens from the `i`-th source token account. Runs the same authorization checks as `burn` (controller role, active, functionality). Unlike `batch_mint`, there is **no whitelist gate** (burning is never whitelist-restricted). Emits one `ControllerRedemption` event per source.

### Parameters

```rust
amounts: Vec<u64>  // raw token units per source; amounts[i] is burned from the i-th source
```

### Remaining accounts

One account per source, in order, appended as `remaining_accounts`:

| Offset (per source `i`) | Account | Mut | Notes |
|---|---|---|---|
| `i` | source token account | yes | burns `amounts[i]` |

### Preconditions

- `!amounts.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() == amounts.len()` — errors `InvalidRemainingAccounts` otherwise (exactly one source per amount).
- `require_role(ROLE_CONTROLLER)` — the `authority` caller must sign and hold `ROLE_CONTROLLER` on this mint.
- `require_active` — mint must not be deactivated.
- `require_functionality(OPERATIONS_BURN)` — the mint's asset-class version must be finalized and enable burning.

### Accounts

The fixed accounts (the per-source token accounts are passed via `remaining_accounts`, see above).

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | no | yes | Signer | The caller; must hold `ROLE_CONTROLLER` on this mint |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | yes | no | UncheckedAccount | Token-2022 mint to burn from |
| `operations_authority` | no | no | UncheckedAccount | seeds `["permanent_delegate", mint]` (owned by this program); signs each burn CPI as the account's delegate |
| `permissioned_burn_authority` | no | no | UncheckedAccount | seeds `["permissioned_burn", mint]` (owned by this program); co-signs each burn CPI as the mint's `PermissionedBurn` authority |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `token_2022_program` | no | no | Program<Token2022> | |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID |

### Execution

1. `require!(!amounts.is_empty())` and `require!(remaining_accounts.len() == amounts.len())`
2. `require_role(ROLE_CONTROLLER)` + `require_active` + `require_functionality(OPERATIONS_BURN)`
3. For each source `i`:
   1. `invoke_signed` → `permissioned_burn::instruction::burn(source, mint, permissioned_burn_authority, operations_authority, amounts[i])`, signed with both `["permanent_delegate", mint, bump]` and `["permissioned_burn", mint, bump]`
   2. Emit `ControllerRedemption { mint, controller: authority, from: source, value: amounts[i] }` via `emit_cpi!`

Both signer seeds are derived once before the loop and reused for every leg.

### Errors

| Code | Cause |
|---|---|
| `EmptyBatch` | `amounts` is empty |
| `InvalidRemainingAccounts` | `remaining_accounts.len() != amounts.len()` |

---

## Instruction: `controller_transfer` (Operational — controller only)

Force-transfers `amount` tokens from the `from` token account to the `to` token account via the permanent delegate, without the holder's consent. Used to move tokens under legal/regulatory instruction (court order, lost-key recovery, mis-delivery). No snapshot CPIs run — like `transfer::transfer`, it is snapshot-agnostic.

> **Transfer-hook contract.** The mint's `TransferHook` extension makes Token-2022 invoke `transfer-hook::execute` on the inner `transfer_checked`, and that hook's double-introspection requires a matching `transfer::verify_transfer` as the *previous* top-level instruction. **A `controller_transfer` transaction must therefore prepend `transfer::verify_transfer` with the same `(source, destination, mint, amount)`** — the hook accepts `operations::controller_transfer` at index N (see [`transfer-hook.md`](transfer-hook.md) step 5), but still rejects a bare one at index 0 with `NoPreviousInstruction`.
>
> Because `verify_transfer` declares `source_owner` as a `Signer`, that pre-instruction makes the holder co-sign the transaction. A controller transfer bypasses the *holder's* compliance state but, as wired today, still requires the holder's signature — it is not a unilateral seizure path.

### Parameters

```rust
amount: u64  // raw token units to transfer
```

### Preconditions

- `require_role(ROLE_CONTROLLER)` — the `authority` caller must sign and hold `ROLE_CONTROLLER` on this mint (checked against its own `["roles", mint, authority]` PDA).
- `require_active` — mint must not be deactivated.
- `require_functionality(OPERATIONS_CONTROLLER_TRANSFER)` — the mint's asset-class version must be finalized and enable controller transfers.

`controller_transfer` itself does **not** check pause, whitelist / transfer-control mode, or frozen-account / frozen-balance markers — its only gates are the controller role and the asset-class functionality bit. Note that the required `transfer::verify_transfer` pre-instruction *does* run those checks, and Token-2022 rejects the inner `transfer_checked` on a paused mint, so in practice they still apply to the transaction as a whole.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | no | yes | Signer | The caller; must hold `ROLE_CONTROLLER` on this mint |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids and is forwarded to the hook |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | no | no | UncheckedAccount | Token-2022 mint; decimals read in the handler for `transfer_checked` |
| `from` | yes | no | UncheckedAccount | Source token account; debited |
| `to` | yes | no | UncheckedAccount | Destination token account; credited |
| `operations_authority` | no | no | UncheckedAccount | seeds `["permanent_delegate", mint]` (owned by this program); signs the transfer CPI |
| `extra_account_meta_list` | no | no | UncheckedAccount | seeds `["extra-account-metas", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; forwarded to Token-2022 for hook resolution |
| `transfer_hook_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_HOOK_PROGRAM_ID` |
| `deploy_program` | no | no | UncheckedAccount | address constrained to `DEPLOY_PROGRAM_ID`; hook metalist index 5 |
| `factory_program` | no | no | UncheckedAccount | address constrained to `FACTORY_PROGRAM_ID`; hook metalist index 7 |
| `instructions_sysvar` | no | no | UncheckedAccount | address constrained to the Instructions sysvar; hook metalist index 9 |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` and forwarded to the hook |
| `token_2022_program` | no | no | Program<Token2022> | |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID |

### Execution

0. *(caller-supplied pre-instruction)* `transfer::verify_transfer(amount)` at index N-1, so the hook's introspection passes
1. `require_role(authority_roles_pda.load()?, ROLE_CONTROLLER)`
2. `require_active(&deactivate_pda)` + `require_functionality(OPERATIONS_CONTROLLER_TRANSFER)`
3. Read `decimals` off the mint (needed for `transfer_checked`)
4. `invoke_signed` → `transfer_checked(from, mint, to, operations_authority, amount, decimals)` signed with `["permanent_delegate", mint, bump]`, with the hook accounts appended in metalist order (`extra_account_meta_list`, `transfer_hook_program`, `deploy_program`, `asset_configuration_pda`, `factory_program`, `asset_class_version_pda`, `instructions_sysvar`)
5. Emit `ControllerTransferred` via `emit_cpi!`

`PermissionedBurn` constrains burning only — it places no requirement on transfers, so `controller_transfer` needs no permissioned-burn signer.

---

## Events

### `ControllerRedemption`

Emitted once per burned token account, after the tokens have been burned — once
for `burn`, and once per source for `batch_burn`. Emitted via **`emit_cpi!`** (self-CPI) rather
than `emit!` so the payload is carried in an inner-instruction and cannot be
truncated by the ingestion layer — the same pattern `deploy` uses for
`MintDeployed`.

```rust
#[event]
pub struct ControllerRedemption {
    pub mint: Pubkey,
    pub controller: Pubkey,  // the `authority` that signed and holds ROLE_CONTROLLER (not `payer`)
    pub from: Pubkey,        // the token account burned from
    pub value: u64,          // raw token units burned
}
```

**Consumer notes:**
- `#[event_cpi]` appends two accounts to `burn`: `event_authority`
  (PDA `["__event_authority"]`) and `program`. Clients using `.accounts()` get
  them auto-resolved; `.accountsStrict()` must pass them explicitly.
- The event is **not** in `Program data:` logs. Read it from the transaction's
  inner instructions: strip the 8-byte self-CPI tag, then decode with the
  program event coder (see
  `tests/program_helpers/burn/burn_instruction_helper.ts::getControllerRedemptionEvent`,
  or `getControllerRedemptionEvents` for the multiple events emitted by `batch_burn`).

### `ControllerTransferred`

Emitted once by `controller_transfer`, after the tokens have moved. Same
`emit_cpi!` (self-CPI) delivery and the same consumer notes as
`ControllerRedemption` above.

```rust
#[event]
pub struct ControllerTransferred {
    pub mint: Pubkey,
    pub controller: Pubkey,  // the `authority` that signed and holds ROLE_CONTROLLER
    pub from: Pubkey,        // the source token account
    pub to: Pubkey,          // the destination token account
    pub value: u64,          // raw token units transferred
}
```

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
