# operations — Program Reference

Program ID: `BHDyg8PeUyVBpmkcjYLdnt3VCmYf4wp8Xeu6TXREiLKp`

Controls token movements that need no holder signature, via the Token-2022 `PermanentDelegate` extension: burning (`burn`, `batch_burn`), force-transfers (`controller_transfer`), and hold executions on behalf of `hold` (`hold_transfer`). Owns the `["permanent_delegate", mint]` PDA that was registered as the permanent delegate during `deploy_mint`. The permanent delegate can burn or transfer tokens from any token account without the account owner's consent.

Because that PDA lives here, every program in the workspace that needs to move tokens without the holder's consent has to route through this program. `hold_transfer` is the first such caller.

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
- `require_hold_covered` — `balance >= held + amount`, so the burn cannot destroy tokens a hold has earmarked. See [The hold lien on these paths](#the-hold-lien-on-these-paths).

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
| `token_account_hold_position_pda` | no | no | UncheckedAccount | seeds `["hold_position", mint, token_account]`, `seeds::program = HOLD_PROGRAM_ID`; read by `require_hold_covered`. May be empty (no hold ever created) |
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

Two accounts per source, in order, appended as `remaining_accounts`:

| Offset (per source `i`) | Account | Mut | Notes |
|---|---|---|---|
| `i * 2` | source token account | yes | burns `amounts[i]` |
| `i * 2 + 1` | its `hold_position` PDA | no | seeds `["hold_position", mint, source]`, `seeds::program = HOLD_PROGRAM_ID`; may be empty. No `seeds` constraint can validate a `remaining_accounts` address, so `require_hold_covered_unverified_pda` re-derives and compares it — otherwise a caller could pass an unrelated empty account and fake a zero lien |

### Preconditions

- `!amounts.is_empty()` — errors `EmptyBatch` if the batch is empty.
- `remaining_accounts.len() == amounts.len() * 2` — errors `InvalidRemainingAccounts` otherwise (exactly two accounts per amount).
- `require_role(ROLE_CONTROLLER)` — the `authority` caller must sign and hold `ROLE_CONTROLLER` on this mint.
- `require_active` — mint must not be deactivated.
- `require_functionality(OPERATIONS_BURN)` — the mint's asset-class version must be finalized and enable burning.
- `require_hold_covered_unverified_pda` per source — `balance >= held + amounts[i]`. See [The hold lien on these paths](#the-hold-lien-on-these-paths).

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
| `InvalidRemainingAccounts` | `remaining_accounts.len() != amounts.len() * 2` |
| `HoldPositionPdaMismatch` | a source's supplied `hold_position` PDA is not the one derived from its seeds |
| `InsufficientSpendableBalance` | `amounts[i]` exceeds `balance − held` for that source |

---

## Instruction: `controller_transfer` (Operational — controller only)

Force-transfers `amount` tokens from the `from` token account to the `to` token account via the permanent delegate, without the holder's consent. Used to move tokens under legal/regulatory instruction (court order, lost-key recovery, mis-delivery). No snapshot CPIs run — like every other transfer path, it is snapshot-agnostic.

> **Transfer-hook contract.** The mint's `TransferHook` extension makes Token-2022 invoke `transfer-hook::execute` on the inner `transfer_checked`. The hook recognises a permanent-delegate transfer — the authority is the `["permanent_delegate", mint]` PDA — and **returns without running any compliance check** (see [`transfer-hook.md`](transfer-hook.md#permanent-delegate-bypass)), so a controller can seize tokens from frozen or non-whitelisted accounts and into them. No pre-instruction and no holder signature are required: this is a genuine unilateral seizure path, gated only by the controller role + functionality.
>
> Token-2022 still resolves the hook's whole `ExtraAccountMetaList`, so `controller_transfer` must forward every compliance PDA even though the hook won't read them (they may be empty — expected for a seizure).

### Parameters

```rust
amount: u64  // raw token units to transfer
```

### Preconditions

- `require_role(ROLE_CONTROLLER)` — the `authority` caller must sign and hold `ROLE_CONTROLLER` on this mint (checked against its own `["roles", mint, authority]` PDA).
- `require_active` — mint must not be deactivated.
- `require_functionality(OPERATIONS_CONTROLLER_TRANSFER)` — the mint's asset-class version must be finalized and enable controller transfers.
- `require_hold_covered` — `balance >= held + amount`. See [The hold lien on these paths](#the-hold-lien-on-these-paths).

Beyond the hold lien, `controller_transfer` does **not** check pause, whitelist / transfer-control mode, or frozen-account / frozen-balance markers, and neither does the hook for this path (it bypasses compliance for permanent-delegate transfers) — its remaining gates are the controller role and the asset-class functionality bit. Pause still applies: Token-2022 rejects the inner `transfer_checked` on a paused mint regardless.

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
| `freeze_program` | no | no | UncheckedAccount | address constrained to `FREEZE_PROGRAM_ID`; hook metalist index 15 |
| `deploy_program` | no | no | UncheckedAccount | address constrained to `DEPLOY_PROGRAM_ID`; hook metalist index 5 |
| `factory_program` | no | no | UncheckedAccount | address constrained to `FACTORY_PROGRAM_ID`; hook metalist index 7 |
| `deactivate_program` | no | no | UncheckedAccount | address constrained to `DEACTIVATE_PROGRAM_ID`; hook metalist index 9 |
| `transfer_control_program` | no | no | UncheckedAccount | address constrained to `TRANSFER_CONTROL_PROGRAM_ID`; hook metalist index 11 |
| `transfer_control_mode_pda` | no | no | UncheckedAccount | seeds `["transfer_control_mode", mint]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; forwarded, may be empty |
| `source_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, from]`; forwarded, may be empty (seizure from a non-whitelisted account) |
| `destination_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, to]`; forwarded, may be empty (seizure to a non-whitelisted account) |
| `source_frozen_pda` | no | no | UncheckedAccount | seeds `["frozen_account", mint, from]`, `seeds::program = FREEZE_PROGRAM_ID`; forwarded, may **exist** (seizure from a frozen account) |
| `source_frozen_balance_pda` | no | no | UncheckedAccount | seeds `["frozen_balance", mint, from]`, `seeds::program = FREEZE_PROGRAM_ID`; forwarded, may be empty |
| `hold_program` | no | no | UncheckedAccount | address constrained to `HOLD_PROGRAM_ID`; hook metalist index 18 |
| `source_hold_position_pda` | no | no | UncheckedAccount | seeds `["hold_position", mint, from]`, `seeds::program = HOLD_PROGRAM_ID`; forwarded, may be empty (no hold ever created on the source) |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` and forwarded to the hook |
| `token_2022_program` | no | no | Program<Token2022> | |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `event_authority` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected PDA, seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Anchor `#[event_cpi]`-injected account; this program's own ID |

### Execution

1. `require_role(authority_roles_pda.load()?, ROLE_CONTROLLER)`
2. `require_active(&deactivate_pda)` + `require_functionality(OPERATIONS_CONTROLLER_TRANSFER)`
3. Read `decimals` off the mint (needed for `transfer_checked`)
4. `invoke_signed` → `transfer_checked(from, mint, to, operations_authority, amount, decimals)` signed with `["permanent_delegate", mint, bump]`, with the hook accounts appended in metalist order via `common::HookAccounts` — this order is load-bearing, independent of the order the accounts are declared in the struct, and shared with every other caller that forwards the block (see [`docs/common.md`](common.md#module-hook_accounts))
5. Emit `ControllerTransferred` via `emit_cpi!`

`PermissionedBurn` constrains burning only — it places no requirement on transfers, so `controller_transfer` needs no permissioned-burn signer.

---

## Instruction: `hold_transfer` (Auxiliary — `hold` only)

Moves `amount` tokens from `from` to `to` via the permanent delegate, on behalf of `hold::execute_hold`. Exists because the mint's `PermanentDelegate` authority is a PDA of *this* program, so only this program can `invoke_signed` it — and a hold execution has no holder signature to transfer with.

Callable by CPI only: `hold_authority` must be the `["hold_authority", mint]` PDA of `hold`, which only `hold` can produce. An external wallet cannot sign for it.

### Parameters

```rust
amount: u64  // raw token units to transfer
```

### Preconditions

`hold_authority.key() == find_program_address(["hold_authority", mint], HOLD_PROGRAM_ID)`, else `UnauthorizedHoldAuthority`.

That is the **only** check. This instruction runs no role, pause, deactivation, functionality, whitelist or freeze check — not because they don't apply, but because `hold::execute_hold` has already run them before calling. The hook cannot run them either: this goes through the permanent delegate, so it takes the compliance bypass. See [`docs/hold.md`](hold.md#why-compliance-is-re-checked-here) for the full argument, and treat this instruction as unsafe to call from anywhere that has not run those checks first.

### Accounts

Same shape as `controller_transfer` minus the role, event, and functionality accounts, plus `hold_authority`:

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `hold_authority` | no | yes | Signer | Must be `["hold_authority", mint]` of `HOLD_PROGRAM_ID` |
| `mint` | no | no | UncheckedAccount | decimals read in the handler |
| `from` | yes | no | UncheckedAccount | Source token account; debited |
| `to` | yes | no | UncheckedAccount | Destination token account; credited |
| `operations_authority` | no | no | UncheckedAccount | seeds `["permanent_delegate", mint]`; signs the transfer CPI |
| *hook block* | no | no | — | The 17 accounts of `common::HookAccounts`, forwarded verbatim |
| `token_2022_program` | no | no | Program<Token2022> | |

`asset_configuration_pda` and `asset_class_version_pda` are typed (`Account` / `AccountLoader`) rather than unchecked purely so their seeds can be validated — nothing here reads their contents.

### Execution

1. Verify `hold_authority` is `hold`'s PDA for this mint.
2. Read `decimals` off the mint.
3. `invoke_signed` → `transfer_checked(from, mint, to, operations_authority, amount, decimals)` signed with `["permanent_delegate", mint, bump]`, with the hook block appended via `common::HookAccounts`.

No event: `hold::execute_hold` emits `HoldExecuted`, which carries everything an indexer needs, and a second event here would double-count the same movement.

---

## The hold lien on these paths

`burn`, `batch_burn` and `controller_transfer` all reduce a holder's balance without the transfer hook enforcing anything: the two burns fire no hook at all (Token-2022 invokes transfer hooks on transfers only), and `controller_transfer` signs as the `permanent_delegate` PDA, which `transfer-hook::execute` exempts from every check. Each therefore calls `common::require_hold_covered` itself, asserting `balance >= held + amount` before the CPI.

Without it, any of the three could leave `held` above the balance. The hook's cover check (`balance_post >= frozen + held`) would then reject **every** transfer out of that account — `hold::execute_hold` included — until the escrows released or the holds expired. A burn is worse still: the tokens are gone, so the hold could never be executed at all, only released or reclaimed.

**The partial freeze is deliberately not part of this check.** A controller can still seize or burn a partially frozen balance; only the hold lien stops them. The two are different kinds of restriction: a hold is a settlement commitment between a holder and an escrow the controller does not control, whereas a partial freeze is an administrative measure applied by the same authority structure the controller belongs to. Blocking the controller on a partial freeze would also be inconsistent with this program's existing behaviour, since a **fully** frozen account is already seizable.

This matches ATS, where the two are enforced by different mechanisms: creating a hold calls `reducePartitionOnly`, moving the amount out of `balanceOfByPartition` so no controller path can reach it, while the ERC-3643 partial freeze is a separate `frozenTokens[account]` counter that `controllerTransferByPartition` neither reads nor is gated on.

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
