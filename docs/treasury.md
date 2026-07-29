# treasury — Program Reference

Program ID: `G71RRNtr2PLZ9Tbmp9CKnxghf3aMoasUwLGPb2u7BytA`

Pays coupon interest to bond holders in a separate token mint (the *payment mint*, e.g. a stablecoin) — distinct from the bond mint the rest of the workspace targets. The payment mint may be **classic SPL Token or Token-2022** — `treasury` uses Anchor's token *interface* so either is accepted.

Both instructions are **role- and functionality-gated**: the `authority` signer must hold `ROLE_TREASURER` on the bond mint (checked against its `access-control` `Roles` PDA via `require_role`), the mint's finalized asset-class version must enable the relevant functionality bit (`TREASURY_SET_PAYMENT_TOKEN` / `TREASURY_PAY_COUPON`, via `require_functionality`), and the bond mint must be neither paused nor deactivated. The deployer signature is no longer verified — `authority` need not be the recorded asset configuration, only a `ROLE_TREASURER` holder.

The check order in both handlers is `require_role → require_not_paused → require_active → require_functionality`.

---

## State

### `TreasuryConfig`

```rust
#[account]
pub struct TreasuryConfig {
    pub bump: u8,
    pub payment_mint: Pubkey,
    pub payment_mint_decimals: u8,
    pub locked_for_coupon_id: u64,
}
// LEN = 8 + 1 + 32 + 1 + 8 = 50 bytes
// Seeds: ["treasury_config", mint]
```

Per-mint treasury config. Stores the payment-mint pubkey and a cached copy of its decimals (avoids re-parsing the mint on every `pay_coupon`). Mint decimals are immutable on both classic SPL Token and Token-2022, so the cache stays correct for as long as `payment_mint` is unchanged. If the treasurer points the treasury at a different payment mint via another `set_payment_token` call, `payment_mint` / `payment_mint_decimals` are overwritten.

`locked_for_coupon_id` is `0` while no claims have been made. The first `pay_coupon` for a coupon sets it to that coupon's id, which locks the payment mint against change: `set_payment_token` then fails with `ClaimsInProgress` until a **new** coupon is created and `coupon_counter.count` advances past `locked_for_coupon_id`. This prevents swapping the payment mint mid-distribution of a coupon.

### `CouponPaidMarker`

```rust
#[account]
pub struct CouponPaidMarker {
    pub bump: u8,
    pub amount: u64,
}
// LEN = 8 + 1 + 8 = 17 bytes
// Seeds: ["coupon_paid", mint, coupon_id.to_le_bytes(), account]
```

One marker per `(mint, coupon_id, account)` triple, where `account` is the pubkey the Merkle proof commits to (in practice the holder's bond-mint token account). Created via `init` inside `pay_coupon` — the second attempt to pay the same coupon to the same holder fails because the PDA already exists. Stores `amount` for off-chain auditing.

### `treasury_authority` PDA (no on-chain account data)

```text
Seeds: ["treasury_authority", mint]
```

Empty PDA. Used as the **owner** of the treasury's payment-mint token account and signs `transfer_checked` (via the token interface — works for both classic SPL Token and Token-2022) during `pay_coupon` through `invoke_signed`. Anyone can fund the treasury simply by transferring payment-mint tokens to its associated token account.

---

## Error Codes

```rust
#[error_code]
pub enum ErrorCode {
    NegativeElapsedTime,                // coupon.period_end_date <= coupon.period_start_date
    AmountOverflow,                     // u128 overflow during interest calculation
    CouponNotMature,                    // cluster clock < coupon.payment_date
    ClaimsInProgress,                   // set_payment_token while a coupon is mid-distribution
}
```

The Merkle-proof failure is **not** a treasury error: `pay_coupon` calls
`common::require_balance_proof`, which raises `common::CommonError::InvalidMerkleProof`
(the same shared helper pattern as `require_role` / `require_functionality`).

Access-control and state errors come from `common`: `MissingRole` / `RoleOutOfBounds` (role check), `FunctionalityNotSupportedError` / `FunctionalityOutOfBounds` / `AssetClassVersionNotFinalized` (functionality gate), and `MintPaused` / `Deactivated` (pause / deactivation).

Account-shape mismatches (wrong mint, wrong owner, wrong token program, wrong payment-mint key) surface as Anchor's built-in constraint errors and need no custom variants:

| Anchor error | Triggered by |
|---|---|
| `ConstraintAddress` | `payment_mint` arg differs from `treasury_config.payment_mint` |
| `ConstraintTokenMint` | a token account's `mint` field doesn't match `payment_mint` |
| `ConstraintTokenOwner` | `treasury_token_account` is not owned by the `treasury_authority` PDA |
| `ConstraintTokenTokenProgram` | a token account or the mint is owned by a different token program than `token_program` |

---

## Instructions

### `set_payment_token()`

Sets (or replaces) the mint used to settle coupon payments for this bond mint.

- Creates `treasury_config` on the first call (`init_if_needed`); overwrites `payment_mint` / `payment_mint_decimals` on subsequent calls (`locked_for_coupon_id` is left untouched).
- Reads `payment_mint`'s decimals from its account data and caches them in `treasury_config`.
- The payment mint is **not** the bond mint — it's the mint used to pay interest (e.g. USDC, classic SPL or Token-2022).
- **Claims guard:** if `treasury_config.locked_for_coupon_id != 0` and `coupon_counter.count` has not advanced past it (a coupon is mid-distribution), the call fails with `ClaimsInProgress`. The `coupon_counter` account may be uninitialized (no coupon created yet); in that case the guard is skipped.

**Preconditions:** `require_role(ROLE_TREASURER)` → `require_not_paused` → `require_active` → `require_functionality(TREASURY_SET_PAYMENT_TOKEN)`.

**Accounts**

| # | Name | Notes |
|---|---|---|
| 0 | `payer` | Signer, mut. Funds rent for `treasury_config` on the first call. |
| 1 | `authority` | Signer. Must hold `ROLE_TREASURER` on this mint. |
| 2 | `asset_configuration_pda` | `Account<AssetConfiguration>`, owned by `deploy`. Seeds `["asset_configuration", mint]`. Used to derive `asset_class_version_pda`. |
| 3 | `deactivate_pda` | Owned by `deactivate`. Seeds `["deactivate", mint]`. Must not exist (verified by `require_active`). |
| 4 | `mint` | Bond's Token-2022 mint. Pause state checked by `require_not_paused`. |
| 5 | `treasury_config` | Owned by `treasury`. `init_if_needed`. Seeds `["treasury_config", mint]`. |
| 6 | `coupon_counter` | Owned by `coupon`. Seeds `["coupon_counter", mint]`. Read manually for the claims guard; may be uninitialized. |
| 7 | `payment_mint` | `InterfaceAccount<Mint>` — classic SPL or Token-2022. Decimals read here. |
| 8 | `asset_class_version_pda` | `AccountLoader<AssetClassVersion>`, owned by `factory`. Seeds `["asset_class_version", config_id, version_id]`. Functionality gate. |
| 9 | `system_program` | — |
| 10 | `authority_roles_pda` | `AccountLoader<Roles>`, owned by `access-control`. Seeds `["roles", mint, authority]`. Read to verify `authority` holds `ROLE_TREASURER`. |
| 11 | `event_authority` | `#[event_cpi]`-injected PDA `["__event_authority"]`; signs the `PaymentTokenSet` self-CPI. |
| 12 | `program` | `#[event_cpi]`-injected; this program's own ID, target of the self-CPI. |

---

### `pay_coupon(coupon_id: u64, account: Pubkey, balance: u64, merkle_proof: Vec<[u8; 32]>)`

Computes and pays the coupon to a single holder.

**Arguments**

| Arg | Meaning |
|---|---|
| `coupon_id` | Which coupon is being paid. Seeds the `coupon` and `coupon_paid` PDAs. |
| `account` | The pubkey the balance is claimed for — the holder's bond-mint token account. Seeds the `coupon_paid` marker and is the first half of the Merkle leaf preimage. |
| `balance` | The holder's bond-mint balance at `coupon.snapshot_id`, in raw mint units. **Caller-supplied but not trusted** — see the verification step below. |
| `merkle_proof` | Sibling hashes, leaf → root, proving `(account, balance)` belongs to the snapshot tree. Empty for a single-leaf tree. |

`account` is an argument, not an account: the program never loads it and never checks that it is a real token account of `mint`. Its only binding to reality is the Merkle proof — a pubkey that isn't a leaf of the snapshot tree cannot produce a valid proof, so it cannot be paid. This is what lets `pay_coupon` drop the per-holder snapshot PDA and the snapshot CPI entirely.

**Order of operations:** `require_role(ROLE_TREASURER)` → `require_not_paused` → `require_active` → `require_functionality(TREASURY_PAY_COUPON)` → maturity gate → Merkle verification → payout math → `transfer_checked` → config lock → marker write → `emit_cpi!`.

**Maturity gate**

After the precondition checks, the handler reads the cluster clock (`Clock::get()?.unix_timestamp`) and rejects with `CouponNotMature` if it has not yet reached `coupon.payment_date`. This prevents paying a coupon early.

**Balance verification**

```rust
require_balance_proof(&merkle_proof, snapshot_merkle_root.merkle_root, account, balance)?;
```

`require_balance_proof` is a thin `common` wrapper (mirroring `verify_whitelist_pda`)
that calls the pure `merkle::verify_balance_proof` primitive and raises
`CommonError::InvalidMerkleProof` on failure — keeping the crypto primitive a
host-testable `bool` while matching the `require_*` convention.

- The root comes from the `snapshot_merkle_root` PDA of `coupon.snapshot_id` (seeds `["snapshot_merkle_root", mint, coupon.snapshot_id]`, owned by `snapshot`, written once and immutable by `take_snapshot`). Anchor derives that PDA from `coupon.snapshot_id` itself, so the caller cannot point the instruction at a different snapshot's root.
- The leaf is `keccak(account || balance.to_le_bytes())` — 40 bytes. Internal nodes hash two 32-byte children (64 bytes). The differing preimage lengths are what stops an internal node from being replayed as a leaf; see the `// SECURITY:` note in `common::merkle`.
- The tree is **sorted-pair (commutative)**: each step hashes `min(computed, sibling) || max(computed, sibling)`, so no direction bits travel with the proof. The consequence is that only *leaf existence* is proven, never leaf position. That is sufficient here because the double-payment guard is the `coupon_paid` PDA, keyed by `(coupon_id, account)` — position in the tree is irrelevant.
- Verification is pure computation on `Vec<[u8; 32]>`; proof length grows as `log2(holders)`, so a 1M-holder snapshot costs ~20 keccak syscalls.
- Off-chain, tests build leaves and roots with `tests/program_helpers/snapshot/merkle_helper.ts` (`leafHash` mirrors `common::merkle::leaf_hash` exactly); production callers must use the same encoding.

**Computation**

```
              interest_rate × balance × par_value × elapsed_seconds × 10^payment_mint_dec
amount  =  ─────────────────────────────────────────────────────────────────────────────────────
              10^interest_dec × 10^bond_mint_dec × 10^par_value_dec × day_count × 86_400
```

- `interest_rate` and `interest_dec` are resolved as follows: if the coupon carries `interest_rate_override` and `interest_rate_override_decimals` (both `Some`), those values are used; otherwise the handler falls back to `bond_terms.interest_rate` / `bond_terms.interest_rate_decimals`. `par_value`, `par_value_dec`, `issuance_date`, and `day_count_convention` always come from `bond_terms` (bond, seeds `["bond_terms", mint]`).
- `bond_mint_dec` is read directly from the bond `mint` (`InterfaceAccount<Mint>`).
- `payment_mint_dec` is the cached value in `treasury_config` set by `set_payment_token`.
- `coupon.snapshot_id`, `coupon.period_start_date`, `coupon.period_end_date`, and `coupon.payment_date` come from `coupon` (coupon, seeds `["coupon", mint, coupon_id]`).
- `balance` is supplied by the caller and **verified** against the snapshot's Merkle root via `common::require_balance_proof(&merkle_proof, snapshot_merkle_root.merkle_root, account, balance)?`, which raises `CommonError::InvalidMerkleProof` if the proof does not fold to the root. The root is read from the `snapshot_merkle_root` PDA of `coupon.snapshot_id` (seeds `["snapshot_merkle_root", mint, coupon.snapshot_id]`, owned by `snapshot`). The leaf is `keccak(account || balance.to_le_bytes())` in a sorted-pair tree — see `common::merkle`.
- `elapsed_seconds = coupon.period_end_date − coupon.period_start_date` — the accrual window of *this* coupon, not the time since bond issuance. Each coupon accrues independently. The non-positive case can't normally happen because `coupon::create_coupon` enforces strict `>`, but defence-in-depth: `NegativeElapsedTime` if it ever does.
- `day_count` is `360` or `365` per `bond_terms.day_count_convention` (Actual360 / Actual365).

**Why `10^bond_mint_dec` and `10^payment_mint_dec`.** `balance` is in raw bond-mint units, so dividing by `10^bond_mint_dec` converts it to "number of bonds". The result of the inner expression is in *real currency* (e.g. dollars); multiplying by `10^payment_mint_dec` converts it to raw payment-mint units suitable for `transfer_checked`. Without these factors the result is silently wrong as soon as the bond mint and payment mint don't share the same decimal count.

**Algebraic simplification used in the handler.** All four `10^…` factors collapse into one signed exponent

```
net_power = payment_mint_dec − (interest_dec + bond_mint_dec + par_value_dec)
```

applied to one side of the fraction (multiply numerator if `net_power ≥ 0`, multiply denominator by `10^|net_power|` otherwise). This keeps intermediate `u128` values smaller than the naive form — same precision, lower overflow risk. The division at the end is a single integer division (rounds toward zero). Anything that overflows `u128` or doesn't fit back into `u64` fails with `AmountOverflow`.

**Transfer**

`transfer_checked` via the **token interface** (`anchor_spl::token_interface::transfer_checked`) — dispatches through whichever token program owns the mint (classic SPL or Token-2022). Source: `treasury_token_account`. Destination: `holder_payment_account`. Signed by `treasury_authority` PDA via `invoke_signed`. The decimals argument comes from the cached `payment_mint_decimals` in `treasury_config`.

**Config lock**

On success the handler sets `treasury_config.locked_for_coupon_id = coupon_id` (idempotent across holders of the same coupon). This blocks `set_payment_token` from swapping the payment mint while this coupon is still being distributed — see `ClaimsInProgress` above. `treasury_config` is therefore `mut` in this instruction (it was read-only before).

**Double-payment guard**

The `coupon_paid` marker PDA is created via `init` (not `init_if_needed`) and keyed by `(coupon_id, account)` — **not** `snapshot_id`, so the same snapshot can back several corporate actions independently. The second `pay_coupon` for the same `(coupon_id, account)` fails to create the account and reverts the whole transaction — so the holder receives the coupon at most once.

**Accounts**

| # | Name | Notes |
|---|---|---|
| 0 | `payer` | Signer, mut. Funds rent for the `coupon_paid` marker. |
| 1 | `authority` | Signer. Must hold `ROLE_TREASURER` on this mint. |
| 2 | `asset_configuration_pda` | `Account<AssetConfiguration>`. Seeds `["asset_configuration", mint]`. Used to derive `asset_class_version_pda`. |
| 3 | `deactivate_pda` | Seeds `["deactivate", mint]`. Must not exist. |
| 4 | `mint` | Bond's Token-2022 mint, loaded as `InterfaceAccount<Mint>` so `decimals` is available for the payout math. Pause state checked by `require_not_paused` from the same account data. |
| 5 | `treasury_config` | **mut** (locked to `coupon_id` on success). Seeds `["treasury_config", mint]`. |
| 6 | `treasury_authority` | Empty PDA. Seeds `["treasury_authority", mint]`. Owner of `treasury_token_account`; signs the transfer via `invoke_signed`. |
| 7 | `payment_mint` | `InterfaceAccount<Mint>`. Anchor enforces `address = treasury_config.payment_mint` and `mint::token_program = token_program`. |
| 8 | `treasury_token_account` | **Source** of the transfer. `InterfaceAccount<TokenAccount>`, mut. Anchor enforces `token::mint = payment_mint`, `token::authority = treasury_authority`, `token::token_program = token_program`. |
| 9 | `holder_payment_account` | **Destination** of the transfer. `InterfaceAccount<TokenAccount>`, mut. Anchor enforces `token::mint = payment_mint` and `token::token_program = token_program`. **Owner intentionally NOT enforced** — the treasurer chooses where the payment lands. |
| 10 | `bond_terms` | Read-only. Read for `interest_rate` / `interest_rate_decimals` (fallback), `par_value` / `par_value_decimals`, `day_count_convention`. Seeds `["bond_terms", mint]`, owned by `bond`. |
| 11 | `coupon` | Read-only. Read for `snapshot_id`, `payment_date`, `period_start_date` / `period_end_date`, and the optional `interest_rate_override`. Seeds `["coupon", mint, coupon_id]`, owned by `coupon`. |
| 12 | `snapshot_merkle_root` | `Account<SnapshotMerkleRoot>`, read-only, owned by `snapshot`. Seeds `["snapshot_merkle_root", mint, coupon.snapshot_id]`. Its `merkle_root` is the commitment the `(account, balance)` proof is checked against. |
| 13 | `coupon_paid` | `init`. Seeds `["coupon_paid", mint, coupon_id, account]`. **The double-payment guard.** |
| 14 | `asset_class_version_pda` | `AccountLoader<AssetClassVersion>`, owned by `factory`. Seeds `["asset_class_version", config_id, version_id]`. Functionality gate. |
| 15 | `token_program` | `Interface<TokenInterface>` — classic SPL or Token-2022. The mint and both token accounts must all be owned by this program. |
| 16 | `system_program` | — |
| 17 | `authority_roles_pda` | `AccountLoader<Roles>`, owned by `access-control`. Seeds `["roles", mint, authority]`. Read to verify `authority` holds `ROLE_TREASURER`. |
| 18 | `event_authority` | `#[event_cpi]`-injected PDA `["__event_authority"]`; signs the `CouponPaid` self-CPI. |
| 19 | `program` | `#[event_cpi]`-injected; this program's own ID, target of the self-CPI. |

Note there is **no** `holder_token_account` and **no** `snapshot_program` account — both existed while the balance was fetched by CPI and were dropped when the Merkle proof replaced it. Clients using `.accountsStrict()` must not pass them.

### A note on `Box<…>` in the accounts struct

In the Rust source, every `InterfaceAccount<…>` and `Account<…>` field above is wrapped in `Box<…>` (e.g. `Box<InterfaceAccount<'info, Mint>>`), with the sole exception of `asset_configuration_pda`. This is *not* a behavioural change — it's a fix for the BPF runtime's 4 KB per-call-frame stack limit.

By default Anchor materialises the deserialised struct **on the stack**. Two `Mint` + two `TokenAccount` + five `Account<…>` fields (`treasury_config`, `bond_terms`, `coupon`, `snapshot_merkle_root`, `coupon_paid`) stacked together push us past 4 KB → "access violation in stack frame" at validation time, before any handler logic runs. Boxing moves each deserialised payload to the heap and leaves only an 8-byte pointer on the stack. `Box<T>` auto-dereferences, so the handler reads `mint.decimals`, `cfg.payment_mint`, etc. exactly as if the fields weren't boxed.

If you ever add another deserialised account here, box it too. If you remove enough fields that the stack budget no longer matters, the boxes can be dropped — but with the current set they're load-bearing.

---

## Events

Both instructions emit their event via **`emit_cpi!`** (self-CPI) rather than
`emit!`, so the payload is carried in an inner instruction and cannot be
truncated by the ingestion layer — the same pattern `deploy` uses for
`MintDeployed`.

### `CouponPaid`

Emitted once at the end of a successful `pay_coupon`, after the payment has been
transferred from the treasury to the holder and the `coupon_paid` marker has
been created.

```rust
#[event]
pub struct CouponPaid {
    pub mint: Pubkey,
    pub coupon_id: u64,
    pub holder_token_account: Pubkey,
    pub payment_mint: Pubkey,
    pub amount: u64,  // raw payment-mint units transferred
    pub payer: Pubkey,
}
```

`holder_token_account` carries the `account` argument — the pubkey the Merkle proof committed to. The field name is kept for wire compatibility with existing consumers; it is no longer sourced from an account in the instruction.

### `PaymentTokenSet`

Emitted once at the end of a successful `set_payment_token`, after
`treasury_config` has cached the payment mint.

```rust
#[event]
pub struct PaymentTokenSet {
    pub mint: Pubkey,
    pub payment_mint: Pubkey,
}
```

**Consumer notes:**
- `#[event_cpi]` appends two accounts to each instruction: `event_authority`
  (PDA `["__event_authority"]`) and `program`. Clients using `.accounts()` get
  them auto-resolved; `.accountsStrict()` must pass them explicitly.
- The events are **not** in `Program data:` logs. Read them from the
  transaction's inner instructions: strip the 8-byte self-CPI tag, then decode
  with the program event coder (see
  `tests/program_helpers/treasury/treasury_instruction_helper.ts::getCouponPaidEvent` /
  `getPaymentTokenSetEvent`).

---

## Funding the treasury

`treasury` does not expose a deposit instruction. To fund the treasury, transfer payment-mint tokens to the associated token account of `treasury_authority` for `payment_mint` using a regular `transfer_checked` (classic SPL Token or Token-2022, depending on which program owns the mint) from any source. Once funded, `pay_coupon` can draw against that balance.

---

## Why two-step (config + pay) instead of one-shot

`set_payment_token` is decoupled from `pay_coupon` so a treasurer can fix or replace the payment mint without touching coupons, and so `pay_coupon` runs with a stable, on-chain-pinned payment mint that all callers verify against.

---

## Why the balance is proven, not read

`pay_coupon` originally CPI'd `snapshot::get_holderbalance_snapshot_at(coupon.snapshot_id)`, which read a per-holder `["snapshot_holderbalance", mint, holder_token_account]` PDA maintained by the transfer hook, with a fallback to the live token-account balance when the holder had not transacted since the snapshot.

That design costs one account per holder per mint, written on every transfer by the hook — which resolves its accounts inside Token-2022's 32 KiB heap (see [`transfer-hook.md`](transfer-hook.md#metalist-contents)). `take_snapshot` now commits the whole holder set as one 32-byte Merkle root in a single immutable PDA, and `pay_coupon` verifies against it. What this buys:

- **Constant on-chain state per snapshot** instead of O(holders) PDAs, and no per-transfer snapshot writes.
- **No cross-program CPI in the payout path** — one less program to keep in the account list, less compute, a smaller `PayCoupon` account struct.
- **No live-balance fallback.** The old behaviour silently paid the *current* balance when no snapshot entry existed, which was correct for a fresh holder and wrong for anyone who transferred out after the snapshot. The Merkle root has no such hole: a balance is either in the committed set or unpayable.

The trade-off is that the payer must now supply the proof. Building it requires the full holder set as of the snapshot — the same data the indexer already needs to produce the root, so it lives off-chain by construction.
