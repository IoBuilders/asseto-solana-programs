# treasury — Program Reference

Program ID: `G71RRNtr2PLZ9Tbmp9CKnxghf3aMoasUwLGPb2u7BytA`

Pays coupon interest to bond holders in a separate token mint (the *payment mint*, e.g. a stablecoin) — distinct from the bond mint the rest of the workspace targets. The payment mint may be **classic SPL Token or Token-2022** — `treasury` uses Anchor's token *interface* so either is accepted.

Both instructions are **role- and functionality-gated**: the `authority` signer must hold `ROLE_TREASURER` on the bond mint (checked against its `access-control` `Roles` PDA via `require_role`), the mint's finalized asset-class version must enable the relevant functionality bit (`TREASURY_SET_PAYMENT_TOKEN` / `TREASURY_PAY_COUPON`, via `require_functionality`), and the bond mint must be neither paused nor deactivated. The deployer signature is no longer verified — `authority` need not be the recorded mint owner, only a `ROLE_TREASURER` holder.

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
// Seeds: ["coupon_paid", mint, coupon_id.to_le_bytes(), holder_token_account]
```

One marker per `(mint, coupon_id, holder_token_account)` triple. Created via `init` inside `pay_coupon` — the second attempt to pay the same coupon to the same holder fails because the PDA already exists. Stores `amount` for off-chain auditing.

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
    NegativeElapsedTime,                // coupon.payment_date < bond_terms.issuance_date
    AmountOverflow,                     // u128 overflow during interest calculation
    CouponNotMature,                    // cluster clock < coupon.payment_date
    ClaimsInProgress,                   // set_payment_token while a coupon is mid-distribution
}
```

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
| 2 | `mint_owner_pda` | `Account<MintOwner>`, owned by `deploy`. Seeds `["mint_owner", mint]`. Used to derive `asset_class_version_pda`. |
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

### `pay_coupon(coupon_id: u64)`

Computes and pays the coupon to a single holder.

**Preconditions:** `require_role(ROLE_TREASURER)` → `require_not_paused` → `require_active` → `require_functionality(TREASURY_PAY_COUPON)`, run before the maturity gate below.

**Maturity gate**

After the precondition checks, the handler reads the cluster clock (`Clock::get()?.unix_timestamp`) and rejects with `CouponNotMature` if it has not yet reached `coupon.payment_date`. This prevents paying a coupon early.

**Computation**

```
              interest_rate × holder_balance × par_value × elapsed_seconds × 10^payment_mint_dec
amount  =  ─────────────────────────────────────────────────────────────────────────────────────
              10^interest_dec × 10^bond_mint_dec × 10^par_value_dec × day_count × 86_400
```

- `interest_rate` and `interest_dec` are resolved as follows: if the coupon carries `interest_rate_override` and `interest_rate_override_decimals` (both `Some`), those values are used; otherwise the handler falls back to `bond_terms.interest_rate` / `bond_terms.interest_rate_decimals`. `par_value`, `par_value_dec`, `issuance_date`, and `day_count_convention` always come from `bond_terms` (bond, seeds `["bond_terms", mint]`).
- `bond_mint_dec` is read directly from the bond `mint` (`InterfaceAccount<Mint>`).
- `payment_mint_dec` is the cached value in `treasury_config` set by `set_payment_token`.
- `coupon.snapshot_id`, `coupon.period_start_date`, `coupon.period_end_date`, and `coupon.payment_date` come from `coupon` (coupon, seeds `["coupon", mint, coupon_id]`).
- `holder_balance` is read by **CPI to `snapshot::get_holderbalance_snapshot_at(coupon.snapshot_id)`** — the snapshot program handles the case where the holder hasn't transacted post-snapshot by falling back to the live token-account balance.
- `elapsed_seconds = coupon.period_end_date − coupon.period_start_date` — the accrual window of *this* coupon, not the time since bond issuance. Each coupon accrues independently. The non-positive case can't normally happen because `coupon::create_coupon` enforces strict `>`, but defence-in-depth: `NegativeElapsedTime` if it ever does.
- `day_count` is `360` or `365` per `bond_terms.day_count_convention` (Actual360 / Actual365).

**Why `10^bond_mint_dec` and `10^payment_mint_dec`.** `holder_balance` is in raw bond-mint units, so dividing by `10^bond_mint_dec` converts it to "number of bonds". The result of the inner expression is in *real currency* (e.g. dollars); multiplying by `10^payment_mint_dec` converts it to raw payment-mint units suitable for `transfer_checked`. Without these factors the result is silently wrong as soon as the bond mint and payment mint don't share the same decimal count.

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

The `coupon_paid` marker PDA is created via `init` (not `init_if_needed`). The second `pay_coupon(coupon_id)` for the same `holder_token_account` fails to create the account and reverts the whole transaction — so the holder receives the coupon at most once.

**Accounts**

| # | Name | Notes |
|---|---|---|
| 0 | `payer` | Signer, mut. Funds rent for the `coupon_paid` marker. |
| 1 | `authority` | Signer. Must hold `ROLE_TREASURER` on this mint. |
| 2 | `mint_owner_pda` | `Account<MintOwner>`. Seeds `["mint_owner", mint]`. Used to derive `asset_class_version_pda`. |
| 3 | `deactivate_pda` | Seeds `["deactivate", mint]`. Must not exist. |
| 4 | `mint` | Bond's Token-2022 mint, loaded as `InterfaceAccount<Mint>` so `decimals` is available for the payout math. Pause state checked by `require_not_paused` from the same account data. |
| 5 | `treasury_config` | **mut** (locked to `coupon_id` on success). Seeds `["treasury_config", mint]`. |
| 6 | `treasury_authority` | PDA. Seeds `["treasury_authority", mint]`. Signs the transfer via `invoke_signed`. |
| 7 | `payment_mint` | `InterfaceAccount<Mint>`. Anchor enforces `address = treasury_config.payment_mint` and `mint::token_program = token_program`. |
| 8 | `treasury_token_account` | `InterfaceAccount<TokenAccount>`, mut. Anchor enforces `token::mint = payment_mint`, `token::authority = treasury_authority`, `token::token_program = token_program`. |
| 9 | `holder_payment_account` | `InterfaceAccount<TokenAccount>`, mut. Anchor enforces `token::mint = payment_mint` and `token::token_program = token_program`. **Owner intentionally NOT enforced** — the treasurer chooses where the payment lands. |
| 10 | `holder_token_account` | Bond-mint token account for the holder. Used as a seed for the snapshot PDA + `coupon_paid` marker, and forwarded to the snapshot CPI for the live-balance fallback. |
| 11 | `bond_terms` | Read-only. Seeds `["bond_terms", mint]`, owned by `bond`. |
| 12 | `coupon` | Read-only. Seeds `["coupon", mint, coupon_id]`, owned by `coupon`. |
| 13 | `holder_balance_snapshot` | Forwarded to the snapshot CPI. Seeds `["snapshot_holderbalance", mint, holder_token_account]`, owned by `snapshot`. |
| 14 | `coupon_paid` | `init`. Seeds `["coupon_paid", mint, coupon_id, holder_token_account]`. **The double-payment guard.** |
| 15 | `asset_class_version_pda` | `AccountLoader<AssetClassVersion>`, owned by `factory`. Seeds `["asset_class_version", config_id, version_id]`. Functionality gate. |
| 16 | `token_program` | `Interface<TokenInterface>` — classic SPL or Token-2022. The mint and both token accounts must all be owned by this program. |
| 17 | `snapshot_program` | Address-pinned to `snapshot::ID`. |
| 18 | `system_program` | — |
| 19 | `authority_roles_pda` | `AccountLoader<Roles>`, owned by `access-control`. Seeds `["roles", mint, authority]`. Read to verify `authority` holds `ROLE_TREASURER`. |
| 20 | `event_authority` | `#[event_cpi]`-injected PDA `["__event_authority"]`; signs the `CouponPaid` self-CPI. |
| 21 | `program` | `#[event_cpi]`-injected; this program's own ID, target of the self-CPI. |

### A note on `Box<…>` in the accounts struct

In the Rust source, every `InterfaceAccount<…>` and `Account<…>` field above is wrapped in `Box<…>` (e.g. `Box<InterfaceAccount<'info, Mint>>`). This is *not* a behavioural change — it's a fix for the BPF runtime's 4 KB per-call-frame stack limit.

By default Anchor materialises the deserialised struct **on the stack**. Two `Mint` + two `TokenAccount` + four `Account<…>` fields stacked together push us past 4 KB → "access violation in stack frame" at validation time, before any handler logic runs. Boxing moves each deserialised payload to the heap and leaves only an 8-byte pointer on the stack. `Box<T>` auto-dereferences, so the handler reads `mint.decimals`, `cfg.payment_mint`, etc. exactly as if the fields weren't boxed.

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
  `tests/program_helpers/treasury_helper.ts::getCouponPaidEvent` /
  `getPaymentTokenSetEvent`).

---

## Funding the treasury

`treasury` does not expose a deposit instruction. To fund the treasury, transfer payment-mint tokens to the associated token account of `treasury_authority` for `payment_mint` using a regular `transfer_checked` (classic SPL Token or Token-2022, depending on which program owns the mint) from any source. Once funded, `pay_coupon` can draw against that balance.

---

## Why two-step (config + pay) instead of one-shot

`set_payment_token` is decoupled from `pay_coupon` so a treasurer can fix or replace the payment mint without touching coupons, and so `pay_coupon` runs with a stable, on-chain-pinned payment mint that all callers verify against.
