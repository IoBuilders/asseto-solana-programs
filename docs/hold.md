# hold — Program Reference

Program ID: `J8iq5Qz8tXLswZBbUFHuJukf3jpwEXLGVpvFoPZb2qY3`

Ports ERC-1996 (Holdable) to this workspace: a holder earmarks part of their balance for a future settlement, and a designated third party — the **escrow**, acting as notary — decides whether it is delivered or given back.

A hold is a **lien, not a custody transfer**: the tokens never leave the holder's token account. `hold` records the earmarked amount in a per-`(mint, token_account)` accumulator, and `transfer-hook::execute` subtracts it from the spendable balance on every transfer, the same way it subtracts `freeze`'s partial-freeze balance. Only `execute_hold` moves tokens, and it does so through `operations::hold_transfer` because the mint's permanent delegate is the only authority that can move tokens without the holder's signature.

Because held tokens stay in the holder's token account, a snapshot attributes them to the holder and `treasury::pay_coupon` pays the holder for them.

---

## Model

| Concept | Who | What they can do |
|---|---|---|
| **holder** | owner of the source token account | `create_hold` against their own balance. Cannot execute, release or reclaim. |
| **controller** | holder of `ROLE_CONTROLLER` | `controller_create_hold` — imposes a hold on someone else's position, with no holder signature. Cannot execute or release it. |
| **escrow** (notary) | any pubkey, chosen per hold | The only signer that can `execute_hold` or `release_hold`. |
| **anyone** | — | `reclaim_hold`, once the expiration has lapsed. |

The escrow is a plain `Pubkey` recorded on the hold — not a token account and not a program authority. Setting it to the holder gives a self-cancellable reserve; setting it to the recipient gives a claim the holder cannot revoke; setting it to a settlement agent gives the ERC-1996 arrangement.

Because a Solana transaction is atomic across multiple signers, two holds with `escrow = holder` on opposite sides of a trade give delivery-versus-payment with no trusted third party: each side signs its own `execute_hold`, both land in one transaction, and neither can execute the other's leg. `expiration` is the only time bound — an execution is valid from creation until it lapses, and there is no preimage condition.

### Lifecycle

```
create_hold / controller_create_hold ──► Active
                                           │
              escrow: execute_hold ────────┼──► tokens to destination, lien reduced
              escrow: release_hold ────────┼──► lien reduced, no tokens move
                                           │      └─ current_amount hits 0 ──► Closed
              anyone (after expiry):       │
                    reclaim_hold ──────────┴──► lien cleared, no tokens move ──► Expired
```

`execute_hold` and `release_hold` both accept a partial `amount`, so a hold can be resolved in several steps and only reaches `Closed` when `current_amount` reaches zero. `Expired` is written by `reclaim_hold`; a hold whose expiration has lapsed but has not been reclaimed is still `Active` on-chain, so off-chain readers derive "expired" from `expiration`.

---

## Gating

One functionality bit, `HOLD_CREATE_HOLD`, covers the whole capability: all five instructions check it. `controller_create_hold` is separated from `create_hold` by the **role**, not by a second bit.

| | `HOLD_CREATE_HOLD` | role | not paused | not deactivated | whitelist |
|---|---|---|---|---|---|
| `create_hold` | ✔ | — (holder signs) | ✔ | ✔ | holder + pinned destination |
| `controller_create_hold` | ✔ | `ROLE_CONTROLLER` | ✔ | ✔ | holder + pinned destination |
| `execute_hold` | ✔ | — (escrow signs) | ✔ | ✔ | source + destination |
| `release_hold` | ✔ | — (escrow signs) | — | — | — |
| `reclaim_hold` | ✔ | — (permissionless) | — | — | — |

The two resolution paths that move no tokens are gated on the functionality bit but not on pause or deactivation, and the asymmetry rests on a property of this workspace: **a mint's functionality mask is fixed for its lifetime.** `asset_configuration_pda.asset_class_version_id` is written once, by `deploy_mint`, and no instruction rewrites it; a finalized `AssetClassVersion` is immutable. So `HOLD_CREATE_HOLD` cannot be turned off under an open hold — if the bit is off, no hold exists on that mint. Pause and deactivation *can* land after holds exist, and deactivation is irreversible, so gating `release_hold` or `reclaim_hold` on them would strand a lien on a holder's balance with no way out.

A single bit for all five also means a hold created by a controller is always resolvable: were `controller_create_hold` gated on a bit of its own, a hold could exist on an asset class whose resolution paths are disabled.

---

## State

### `HoldPosition`

```rust
#[account]
pub struct HoldPosition {
    pub mint: Pubkey,          // 32
    pub token_account: Pubkey, // 32
    pub held_amount: u64,      // 8
    pub next_hold_id: u64,     // 8
    pub bump: u8,              // 1
}

// Seeds: ["hold_position", mint, token_account]
```

| Field | Type | Meaning |
|---|---|---|
| `mint` | `Pubkey` | The mint this position belongs to. Stored first (immediately after the 8-byte discriminator) so `getProgramAccounts` + `memcmp(offset = 8, mint)` can enumerate every position for a mint. |
| `token_account` | `Pubkey` | The token account the lien applies to. Liens are keyed by *token account*, not by owner, because the compliance layer (`whitelist`, `frozen_account`, `frozen_balance`) and the hook's balance check are keyed that way too. |
| `held_amount` | `u64` | Sum of `current_amount` across the account's active holds. This is the number the transfer hook subtracts. |
| `next_hold_id` | `u64` | Monotonic counter, never reset. Each creation takes this id and increments it. |
| `bump` | `u8` | Bump for the position PDA. |

The position is created on the account's first hold and then persists, even at `held_amount == 0`: closing it would reset `next_hold_id` and let a future hold reuse a retired id.

### `Hold`

```rust
#[account]
pub struct Hold {
    pub mint: Pubkey,                 // 32
    pub token_account: Pubkey,        // 32
    pub hold_id: u64,                 // 8
    pub escrow: Pubkey,               // 32
    pub destination: Option<Pubkey>,  // 1 + 32
    pub initial_amount: u64,          // 8
    pub current_amount: u64,          // 8
    pub created_at: i64,              // 8
    pub expiration: i64,              // 8
    pub status: HoldStatus,           // 1
    pub bump: u8,                     // 1
}

// Seeds: ["hold", mint, token_account, hold_id.to_le_bytes()]
```

| Field | Type | Meaning |
|---|---|---|
| `mint` | `Pubkey` | Stored first, same `memcmp(offset = 8)` enumeration pattern as `HoldPosition` and `document::Document`. |
| `token_account` | `Pubkey` | The token account the hold is against. |
| `hold_id` | `u64` | The id this hold was created with; also a PDA seed. |
| `escrow` | `Pubkey` | The notary. Must sign `execute_hold` and `release_hold`. |
| `destination` | `Option<Pubkey>` | Destination *token account*. `Some` pins it at creation, so the holder knows exactly which account can be paid; `None` leaves the choice to the escrow at execution. |
| `initial_amount` | `u64` | The amount at creation. Never changes, so a partially-resolved hold still reports what it was for. |
| `current_amount` | `u64` | What is left to resolve. Reaching zero closes the hold. |
| `created_at` | `i64` | Unix timestamp at creation. |
| `expiration` | `i64` | Unix timestamp. `execute_hold` requires `now < expiration`; `reclaim_hold` requires `now >= expiration`. |
| `status` | `HoldStatus` | `Active` / `Expired` / `Closed`. |
| `bump` | `u8` | Bump for the hold PDA. |

A terminal `Hold` is kept rather than closed: it is the on-chain audit trail for a resolved arrangement, and keeping it means a `hold_id` can never be re-created. The rent is not reclaimable.

---

## Error Codes

```rust
#[error_code]
pub enum ErrorCode {
    ZeroAmount,                    // amount argument is 0
    ExpirationInThePast,           // expiration <= now at creation
    HoldIdMismatch,                // hold_id argument != hold_position.next_hold_id
    InsufficientAvailableBalance,  // balance − frozen − already held < amount
    NotTheEscrow,                  // signer is not the hold's escrow
    HoldNotActive,                 // hold is already Closed or Expired
    HoldExpired,                   // execute_hold after the expiration
    HoldNotExpired,                // reclaim_hold before the expiration
    AmountExceedsHold,             // amount > current_amount
    DestinationMismatch,           // destination account != the pinned one
    MissingDestinationWhitelist,   // destination pinned but its whitelist PDA not supplied
    HeldAmountUnderflow,           // position.held_amount < the amount being resolved
}
```

`HeldAmountUnderflow` is unreachable while `held_amount` equals the sum of every active hold's `current_amount`; it exists to fail loudly rather than wrap if that invariant is ever broken.

---

## Shared creation core

`create_hold` and `controller_create_hold` differ only in who authorises them and which event they emit. Everything after the authorisation — the freeze check, the whitelist logic including the optional pinned destination, the `amount` / `expiration` / `hold_id` validation, the available-balance arithmetic, and the writes to `HoldPosition` and `Hold` — is `pub(crate) fn record_new_hold` in `hold::creation`, which both call. The lien it writes is read by `transfer-hook::execute` and by all three resolution paths, so keeping it in one function is what stops the two creation paths diverging on what "available balance" or "next hold id" means.

---

## Instruction: `create_hold` (Operational)

Earmarks `amount` of the caller's token-account balance for `escrow` to resolve, and records the arrangement as a new `Hold`. Moves no tokens.

### Parameters

```rust
hold_id: u64
amount: u64
expiration: i64
escrow: Pubkey
destination: Option<Pubkey>
```

`hold_id` must equal the position's current `next_hold_id`. It is an argument rather than something the handler reads because the `Hold` PDA is seeded with it: passing it makes the derivation explicit at the call site, and a concurrent hold from the same holder fails with `HoldIdMismatch` instead of landing on a different PDA.

### Preconditions

- `require_not_paused` — the mint must not be paused.
- `require_active` — the mint must not have been deactivated.
- `require_functionality(HOLD_CREATE_HOLD)`.
- `require_unfrozen_account` — `token_account` must not be fully frozen.
- `verify_transfer_control_mode` over `token_account`, plus `destination` when it is pinned.
- `amount > 0` (`ZeroAmount`), `expiration > now` (`ExpirationInThePast`), `hold_id == next_hold_id` (`HoldIdMismatch`).
- `balance − frozen_balance − held_amount >= amount` (`InsufficientAvailableBalance`).

A hold is a commitment, so a non-eligible account cannot make one, nor earmark its balance for a non-eligible destination. When `destination` is `None` there is nothing to check at creation and the destination is validated at execution instead.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Funds the `HoldPosition` (first hold only) and the `Hold`. Distinct from `authority` so a wallet can pay rent without holding the holder's signature. |
| `authority` | no | yes | Signer | Must own `token_account` (enforced by `token::authority`). |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids. |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; read by `require_active`. |
| `mint` | no | no | InterfaceAccount\<Mint\> | Pause state read by `require_not_paused`. |
| `token_account` | no | no | InterfaceAccount\<TokenAccount\> | The holder's token account; `token::mint = mint`, `token::authority = authority`. Its `amount` is the balance the available-balance check starts from. |
| `token_account_frozen_pda` | no | no | UncheckedAccount | seeds `["frozen_account", mint, token_account]`, `seeds::program = FREEZE_PROGRAM_ID`; must be empty. |
| `token_account_frozen_balance_pda` | no | no | UncheckedAccount | seeds `["frozen_balance", mint, token_account]`, `seeds::program = FREEZE_PROGRAM_ID`; may be empty. Its balance is subtracted from what is available to hold. |
| `transfer_control_mode_pda` | no | no | UncheckedAccount | seeds `["transfer_control_mode", mint]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; may be empty (no mode active). |
| `token_account_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, token_account]`, `seeds::program = TRANSFER_CONTROL_PROGRAM_ID`; must exist in whitelist mode. |
| `destination_whitelist_pda` | no | no | Option\<UncheckedAccount\> | Required only when `destination` is pinned (`MissingDestinationWhitelist` otherwise). Its address is checked at runtime by `common::verify_whitelist_pda`, because a seeds constraint cannot be written against an `Option` instruction argument. |
| `hold_position` | yes | no | Account\<HoldPosition\> | seeds `["hold_position", mint, token_account]`; `init_if_needed`. |
| `hold_record` | yes | no | Account\<Hold\> | seeds `["hold", mint, token_account, hold_id]`; `init`. |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version_id]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`. |
| `token_program` | no | no | Interface\<TokenInterface\> | Token-2022. |
| `system_program` | no | no | Program\<System\> | |
| `event_authority` | no | no | UncheckedAccount | Added by `#[event_cpi]`. |
| `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`. |

### Execution

1. Run the preconditions above.
2. Write the position's `mint`, `token_account` and `bump`. The write is unconditional rather than guarded by a "was it just created?" branch: a freshly `init_if_needed`-ed position is all zeroes, and on an existing one the values written are the ones already there, since both derive from the seeds the constraint verified.
3. `held_amount += amount`, `next_hold_id += 1`.
4. Write the `Hold` as `Active` with `initial_amount == current_amount == amount`.
5. Emit `HoldCreated` via `emit_cpi!`.

---

## Instruction: `controller_create_hold` (Management)

Earmarks `amount` of another account's token-account balance, with no signature from that holder. Produces the same `Hold` and the same lien as `create_hold`. Moves no tokens.

### Parameters

Identical to `create_hold` — the target position is an account, not a parameter.

```rust
hold_id: u64
amount: u64
expiration: i64
escrow: Pubkey
destination: Option<Pubkey>
```

### Preconditions

`require_role(ROLE_CONTROLLER)` first, then exactly the checks `create_hold` runs — pause, deactivation, `HOLD_CREATE_HOLD`, frozen account, whitelist over the target token account and the pinned destination, the `amount` / `expiration` / `hold_id` validation, and the available-balance check.

Keeping the whitelist and freeze checks here is a deliberate difference from `operations::controller_transfer`, which skips them because it is a seizure path the hook exempts. A hold is a commitment resolved later by an escrow the controller does not control, and `execute_hold` re-checks the whitelist — so a lien on a non-eligible account could never be delivered, only reclaimed. Failing at creation is the earlier failure. The available-balance check is not optional either: it is what keeps `frozen + held <= balance` true, and breaking that invariant makes the hook's cover check reject **every** transfer from the account until the escrows unwind.

Pause is checked explicitly, unlike in `controller_transfer` where Token-2022 rejects the inner `transfer_checked` on a paused mint. No tokens move here, so nothing downstream would catch it.

### Accounts

Same as `create_hold` except:

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `authority` | no | yes | Signer | Must hold `ROLE_CONTROLLER`. Not required to own `token_account`. |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`. |
| `token_account` | no | no | InterfaceAccount\<TokenAccount\> | The target holder's token account; `token::mint = mint` only, no `token::authority` constraint. |

`payer` stays separate from `authority`, so a controller can impose a hold without the holder funding the rent.

### Execution

1. `require_role(ROLE_CONTROLLER)`, then the remaining preconditions.
2. `record_new_hold` — steps 2 to 4 of `create_hold`.
3. Emit `ControllerHoldCreated` via `emit_cpi!`.

---

## Instruction: `execute_hold` (Operational)

Delivers `amount` of the hold to the destination token account. The only instruction in the program that moves tokens.

### Parameters

```rust
hold_id: u64
amount: u64
```

### Preconditions

- `require_not_paused`, `require_active`.
- `escrow` signer matches `hold_record.escrow` (`NotTheEscrow`).
- `status == Active` (`HoldNotActive`), `now < expiration` (`HoldExpired`).
- `0 < amount <= current_amount` (`ZeroAmount` / `AmountExceedsHold`).
- `destination_token` matches `hold_record.destination` when pinned (`DestinationMismatch`).
- `verify_transfer_control_mode` over source and destination; `require_unfrozen_account` on the source.
- `require_locked_balance_covered(source_token, source_frozen_balance_pda, held_after + amount)`.

### Why compliance is re-checked here

`transfer-hook::execute` returns `Ok(())` immediately when the transfer authority is the `permanent_delegate` PDA, so `operations::controller_transfer` can seize tokens regardless of compliance. An execution routed through the same delegate inherits that exemption, which would let a hold deliver tokens to a non-whitelisted account. `execute_hold` therefore calls the *same* linked-in functions the hook calls (`transfer_control::verify_transfer_control_mode`, `freeze::require_unfrozen_account`, `freeze::require_locked_balance_covered`, `common::require_active`, `common::require_not_paused`) — a second call site, not a second copy of the logic.

`require_functionality(TRANSFER_HOOK_EXECUTE)` is the one hook check *not* mirrored: `execute_hold` gates on `HOLD_CREATE_HOLD`, so a hold stays resolvable on an asset class that permits holds but not ordinary transfers.

Both source and destination are re-validated on every execution, so a destination that was whitelisted at creation and removed from the whitelist before execution fails here.

### Accounts

28 accounts. The `#[event_cpi]` pair aside, they fall into four groups:

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `escrow` | no | yes | Signer | Must equal `hold_record.escrow`. |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`. |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`. |
| `mint` | no | no | InterfaceAccount\<Mint\> | |
| `source_token` | yes | no | InterfaceAccount\<TokenAccount\> | Debited by the CPI. |
| `destination_token` | yes | no | InterfaceAccount\<TokenAccount\> | Credited by the CPI. |
| `hold_position` | yes | no | Account\<HoldPosition\> | seeds `["hold_position", mint, source_token]`. |
| `hold_record` | yes | no | Account\<Hold\> | seeds `["hold", mint, source_token, hold_id]`. |
| `hold_authority` | no | no | UncheckedAccount | seeds `["hold_authority", mint]`; signs the `operations::hold_transfer` CPI via `invoke_signed`. |
| `operations_authority` | no | no | UncheckedAccount | seeds `["permanent_delegate", mint]`, `seeds::program = OPERATIONS_PROGRAM_ID`; the authority that actually moves the tokens. |
| `operations_program` | no | no | UncheckedAccount | address = `OPERATIONS_PROGRAM_ID`; target of the CPI. |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version_id]`, `seeds::program = FACTORY_PROGRAM_ID`. |
| `transfer_control_mode_pda` | no | no | UncheckedAccount | seeds `["transfer_control_mode", mint]`; may be empty. |
| `source_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, source_token]`. |
| `destination_whitelist_pda` | no | no | UncheckedAccount | seeds `["whitelist", mint, destination_token]`. Not optional here — the destination is always known. |
| `source_frozen_pda` | no | no | UncheckedAccount | seeds `["frozen_account", mint, source_token]`. |
| `source_frozen_balance_pda` | no | no | UncheckedAccount | seeds `["frozen_balance", mint, source_token]`; may be empty. |
| `extra_account_meta_list` | no | no | UncheckedAccount | seeds `["extra-account-metas", mint]`, `seeds::program = TRANSFER_HOOK_PROGRAM_ID`; forwarded to `operations`. |
| `transfer_hook_program`, `deploy_program`, `factory_program`, `deactivate_program`, `transfer_control_program`, `freeze_program`, `hold_program` | no | no | UncheckedAccount | Address-constrained program ids; forwarded to `operations` for the hook metalist. |
| `token_2022_program` | no | no | Program\<Token2022\> | |
| `event_authority`, `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`. |

Token-2022 resolves the full `ExtraAccountMetaList` even though the hook then bypasses its checks, so every metalist entry must be forwarded through to `operations` — see [`common.md`](common.md#module-hook_accounts).

### Execution

1. Run the preconditions above.
2. Compute `held_after = held_amount − amount` and assert `balance >= frozen + held_after + amount`. This is the pre-debit restatement of the hook's post-debit cover check, re-checked here because a partial freeze landing after the hold was created can shrink what the balance covers.
3. Write `held_after` and decrement `current_amount`; set `Closed` if it reaches zero. The state writes happen before the CPI so the accounting is correct for anything downstream that reads it.
4. CPI `operations::hold_transfer`, signed by `hold_authority`.
5. Emit `HoldExecuted` via `emit_cpi!`.

---

## Instruction: `release_hold` (Operational)

Gives `amount` of the hold back to the holder by dropping that much of the lien. Moves no tokens.

### Parameters

```rust
hold_id: u64
amount: u64
```

### Preconditions

- `require_functionality(HOLD_CREATE_HOLD)`.
- `escrow` signer matches `hold_record.escrow` (`NotTheEscrow`).
- `status == Active` (`HoldNotActive`).
- `0 < amount <= current_amount` (`ZeroAmount` / `AmountExceedsHold`).

No pause, deactivation or time gate — releasing only removes a restriction on the holder's own balance, so blocking it could only strand a lien. See [Gating](#gating).

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `escrow` | no | yes | Signer | Must equal `hold_record.escrow`. |
| `mint` | no | no | UncheckedAccount | Address only — a seed component; tied to the hold by the `hold_record` seeds. |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`. |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version_id]`, `seeds::program = FACTORY_PROGRAM_ID`. |
| `token_account` | no | no | UncheckedAccount | Address only — a seed component. |
| `hold_position` | yes | no | Account\<HoldPosition\> | seeds `["hold_position", mint, token_account]`. |
| `hold_record` | yes | no | Account\<Hold\> | seeds `["hold", mint, token_account, hold_id]`. |
| `event_authority`, `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`. |

`mint` and `token_account` are `UncheckedAccount`s used purely as seed components — nothing is read off either, and there is no token program in the struct, because nothing moves.

### Execution

1. Run the preconditions above.
2. `held_amount -= amount`, `current_amount -= amount`; set `Closed` if it reaches zero.
3. Emit `HoldReleased` via `emit_cpi!`.

---

## Instruction: `reclaim_hold` (Operational)

Clears an expired hold's remaining lien, restoring the holder's full spending power. Permissionless.

### Parameters

```rust
hold_id: u64
```

### Preconditions

- `require_functionality(HOLD_CREATE_HOLD)`.
- `status == Active` (`HoldNotActive`).
- `now >= expiration` (`HoldNotExpired`).

Same gating as `release_hold`.

### Accounts

Identical to `release_hold` with `caller: Signer` in place of `escrow`. `caller` proves nothing — it is the fee payer, and it is recorded on the event. Anyone can reclaim, so an unresponsive escrow cannot leave a lapsed hold in place.

### Execution

1. Run the preconditions above.
2. `held_amount -= current_amount`, `current_amount = 0`, `status = Expired`.
3. Emit `HoldReclaimed` via `emit_cpi!`.

---

## Events

All five are emitted via `emit_cpi!`.

| Event | Emitted by | Fields |
|---|---|---|
| `HoldCreated` | `create_hold` | `mint`, `token_account`, `hold_id`, `escrow`, `destination`, `amount`, `expiration` |
| `ControllerHoldCreated` | `controller_create_hold` | the same, plus `controller` |
| `HoldExecuted` | `execute_hold` | `mint`, `token_account`, `hold_id`, `escrow`, `destination`, `amount`, `remaining_amount` |
| `HoldReleased` | `release_hold` | `mint`, `token_account`, `hold_id`, `escrow`, `amount`, `remaining_amount` |
| `HoldReclaimed` | `reclaim_hold` | `mint`, `token_account`, `hold_id`, `caller`, `amount` |

`HoldExecuted` and `HoldReleased` carry `remaining_amount` so an indexer can track `current_amount` without re-reading the account.

A controller-imposed hold gets its own event rather than a `controller` field on `HoldCreated`, so an indexer can distinguish the two creation paths without reading the `Hold` account — which records no creator.

---

## Linked-in helpers

Two functions are exported from the crate root for other programs to link in directly (no CPI):

```rust
pub fn held_amount(hold_position_pda: &AccountInfo) -> Result<u64>
pub fn frozen_balance(frozen_balance_pda: &AccountInfo) -> Result<u64>
```

`held_amount` is the lien reader `transfer-hook::execute` calls. It returns `hold_position.held_amount`, or **0 when the PDA does not exist** — an account that has never had a hold created against it. Returning 0 rather than erroring is what lets the hook pass the account unconditionally, and lets mints that never use holds keep working.

`frozen_balance` is its mirror for the partial-freeze lien, reading `freeze::state::FrozenBalance.balance` with the same absent-means-0 rule. It lives here rather than in `freeze` because only the creation paths need the raw number — `freeze`'s own checks compare against the balance internally and never hand it out. Together the two make `balance − frozen − held` computable in one place.

Both go through `Account::<T>::try_from` rather than `try_deserialize`, so the owner check is not skipped — see [`common.md`](common.md).

---

## Interaction with the rest of the workspace

**`transfer-hook`.** Its `ExtraAccountMetaList` carries 15 entries, the last two being the `hold` program id (index 18) and the source `hold_position` PDA (index 19). `execute` calls `freeze::require_locked_balance_covered(source_token, source_frozen_balance_pda, hold::held_amount(source_hold_position_pda))`, asserting `balance_post >= frozen + held`. Because `initialize_extra_account_meta_list` allocates the account with `init` at a fixed size and there is no update path, a mint's metalist cannot grow after deployment — a mint whose metalist predates these two entries cannot support holds.

**`operations`.** Owns the Auxiliary instruction `hold_transfer`, callable only by the `["hold_authority", mint]` PDA — see [`operations.md`](operations.md).

**Every caller that forwards the hook block** (`transfer::batch_transfer`, `operations::controller_transfer`, `operations::hold_transfer`, and clients sending a bare `transfer_checked`) appends the 17 accounts of `common::HookAccounts` — see [`common.md`](common.md#module-hook_accounts).

**The paths the hook does not cover enforce the lien themselves.** `operations::controller_transfer` signs as the permanent delegate, which the hook exempts, and `operations::burn` / `batch_burn` fire no hook at all. All three call `common::require_hold_covered` (`balance >= held + amount`) before moving or destroying tokens, so none of them can push `held` above the balance and leave holds unexecutable. A partial freeze is deliberately *not* part of that check — see [`operations.md`](operations.md#the-hold-lien-on-these-paths).
