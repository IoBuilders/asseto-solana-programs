# treasury — Program Reference

Program ID: `G71RRNtr2PLZ9Tbmp9CKnxghf3aMoasUwLGPb2u7BytA`

Pays coupon interest to bond holders in a separate token mint (the *payment mint*, e.g. a stablecoin) — distinct from the bond mint the rest of the workspace targets. The payment mint may be **classic SPL Token or Token-2022** — `treasury` uses Anchor's token *interface* so either is accepted.

Both instructions are **management** — only callable by the deployer recorded in `deploy`'s `mint_owner_pda`, and only while the bond mint is neither paused nor deactivated.

---

## State

### `TreasuryConfig`

```rust
#[account]
pub struct TreasuryConfig {
    pub bump: u8,
    pub payment_mint: Pubkey,
    pub payment_mint_decimals: u8,
}
// LEN = 8 + 1 + 32 + 1 = 42 bytes
// Seeds: ["treasury_config", mint]
```

Per-mint treasury config. Stores the payment-mint pubkey and a cached copy of its decimals (avoids re-parsing the mint on every `pay_coupon`). Mint decimals are immutable on both classic SPL Token and Token-2022, so the cache stays correct for as long as `payment_mint` is unchanged. If the deployer points the treasury at a different payment mint via another `set_payment_token` call, both fields are overwritten.

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
}
```

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

Sets (or replaces) the Token-2022 mint used to settle coupon payments for this bond mint.

- Creates `treasury_config` on the first call (`init_if_needed`); overwrites both fields on subsequent calls.
- Reads `payment_mint`'s decimals from its account data and caches them in `treasury_config`.
- The payment mint is **not** the bond mint — it's the mint used to pay interest (e.g. USDC, classic SPL or Token-2022).

**Accounts**

| # | Name | Notes |
|---|---|---|
| 0 | `payer` | Signer, mut. Funds rent on first call. |
| 1 | `deployer` | Signer. Verified against `mint_owner_pda` via `verify_deployer`. |
| 2 | `mint_owner_pda` | Owned by `deploy`. Seeds `["mint_owner", mint]`. |
| 3 | `deactivate_pda` | Owned by `deactivate`. Seeds `["deactivate", mint]`. Must not exist (verified by `require_active`). |
| 4 | `mint` | Bond's Token-2022 mint. Pause state checked by `require_not_paused`. |
| 5 | `treasury_config` | Owned by `treasury`. `init_if_needed`. Seeds `["treasury_config", mint]`. |
| 6 | `payment_mint` | `InterfaceAccount<Mint>` — classic SPL or Token-2022. Decimals read here. |
| 7 | `system_program` | — |

---

### `pay_coupon(coupon_id: u64)`

Computes and pays the coupon to a single holder.

**Maturity gate**

Before doing anything else, the handler reads the cluster clock (`Clock::get()?.unix_timestamp`) and rejects with `CouponNotMature` if it has not yet reached `coupon.payment_date`. This prevents paying a coupon early.

**Computation**

```
              interest_rate × holder_balance × par_value × elapsed_seconds × 10^payment_mint_dec
amount  =  ─────────────────────────────────────────────────────────────────────────────────────
              10^interest_dec × 10^bond_mint_dec × 10^par_value_dec × day_count × 86_400
```

- `interest_rate`, `interest_dec`, `par_value`, `par_value_dec`, `issuance_date`, `day_count_convention` come from `bond_terms` (bond, seeds `["bond_terms", mint]`).
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

**Double-payment guard**

The `coupon_paid` marker PDA is created via `init` (not `init_if_needed`). The second `pay_coupon(coupon_id)` for the same `holder_token_account` fails to create the account and reverts the whole transaction — so the holder receives the coupon at most once.

**Accounts**

| # | Name | Notes |
|---|---|---|
| 0 | `payer` | Signer, mut. Funds rent for the `coupon_paid` marker. |
| 1 | `deployer` | Signer. Verified via `verify_deployer`. |
| 2 | `mint_owner_pda` | Seeds `["mint_owner", mint]`. |
| 3 | `deactivate_pda` | Seeds `["deactivate", mint]`. Must not exist. |
| 4 | `mint` | Bond's Token-2022 mint, loaded as `InterfaceAccount<Mint>` so `decimals` is available for the payout math. Pause state checked by `require_not_paused` from the same account data. |
| 5 | `treasury_config` | Read-only. Seeds `["treasury_config", mint]`. |
| 6 | `treasury_authority` | PDA. Seeds `["treasury_authority", mint]`. Signs the transfer via `invoke_signed`. |
| 7 | `payment_mint` | `InterfaceAccount<Mint>`. Anchor enforces `address = treasury_config.payment_mint` and `mint::token_program = token_program`. |
| 8 | `treasury_token_account` | `InterfaceAccount<TokenAccount>`, mut. Anchor enforces `token::mint = payment_mint`, `token::authority = treasury_authority`, `token::token_program = token_program`. |
| 9 | `holder_payment_account` | `InterfaceAccount<TokenAccount>`, mut. Anchor enforces `token::mint = payment_mint` and `token::token_program = token_program`. **Owner intentionally NOT enforced** — deployer chooses where the payment lands. |
| 10 | `holder_token_account` | Bond-mint token account for the holder. Used as a seed for the snapshot PDA + `coupon_paid` marker, and forwarded to the snapshot CPI for the live-balance fallback. |
| 11 | `bond_terms` | Read-only. Seeds `["bond_terms", mint]`, owned by `bond`. |
| 12 | `coupon` | Read-only. Seeds `["coupon", mint, coupon_id]`, owned by `coupon`. |
| 13 | `holder_balance_snapshot` | Forwarded to the snapshot CPI. Seeds `["snapshot_holderbalance", mint, holder_token_account]`, owned by `snapshot`. |
| 14 | `coupon_paid` | `init`. Seeds `["coupon_paid", mint, coupon_id, holder_token_account]`. **The double-payment guard.** |
| 15 | `token_program` | `Interface<TokenInterface>` — classic SPL or Token-2022. The mint and both token accounts must all be owned by this program. |
| 16 | `snapshot_program` | Address-pinned to `snapshot::ID`. |
| 17 | `system_program` | — |

### A note on `Box<…>` in the accounts struct

In the Rust source, every `InterfaceAccount<…>` and `Account<…>` field above is wrapped in `Box<…>` (e.g. `Box<InterfaceAccount<'info, Mint>>`). This is *not* a behavioural change — it's a fix for the BPF runtime's 4 KB per-call-frame stack limit.

By default Anchor materialises the deserialised struct **on the stack**. Two `Mint` + two `TokenAccount` + four `Account<…>` fields stacked together push us past 4 KB → "access violation in stack frame" at validation time, before any handler logic runs. Boxing moves each deserialised payload to the heap and leaves only an 8-byte pointer on the stack. `Box<T>` auto-dereferences, so the handler reads `mint.decimals`, `cfg.payment_mint`, etc. exactly as if the fields weren't boxed.

If you ever add another deserialised account here, box it too. If you remove enough fields that the stack budget no longer matters, the boxes can be dropped — but with the current set they're load-bearing.

---

## Funding the treasury

`treasury` does not expose a deposit instruction. To fund the treasury, transfer payment-mint tokens to the associated token account of `treasury_authority` for `payment_mint` using a regular `transfer_checked` (classic SPL Token or Token-2022, depending on which program owns the mint) from any source. Once funded, `pay_coupon` can draw against that balance.

---

## Why two-step (config + pay) instead of one-shot

`set_payment_token` is decoupled from `pay_coupon` so the deployer can fix or replace the payment mint without touching coupons, and so `pay_coupon` runs with a stable, on-chain-pinned payment mint that all callers verify against.
