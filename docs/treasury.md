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
}
// LEN = 8 + 1 + 32 + 1 = 42 bytes
// Seeds: ["treasury_config", mint]
```

Per-mint treasury config. Stores the payment-mint pubkey and a cached copy of its decimals (avoids re-parsing the mint on every `pay_coupon`). Mint decimals are immutable on both classic SPL Token and Token-2022, so the cache stays correct for as long as `payment_mint` is unchanged. If the treasurer points the treasury at a different payment mint via another `set_payment_token` call, `payment_mint` / `payment_mint_decimals` are overwritten.

`treasury_config` only says which mint the **next** coupon distribution will use. A coupon whose distribution has already started keeps the mint it was opened with (see `CouponDistribution` below), so `set_payment_token` needs no lock and can run at any time.

### `CouponDistribution`

```rust
#[account]
pub struct CouponDistribution {
    pub bump: u8,
    pub payment_mint: Pubkey,
    pub payment_mint_decimals: u8,
    pub interest_rate: u64,
    pub interest_rate_decimals: u8,
    pub par_value: u64,
    pub par_value_decimals: u8,
    pub day_count_days: u16,
    pub paid_count: u64,
    pub total_paid: u64,
}
// LEN = 8 + 1 + 32 + 1 + 8 + 1 + 8 + 1 + 2 + 8 + 8 = 78 bytes
// Seeds: ["coupon_distribution", mint, coupon_id.to_le_bytes()]
```

The economic terms of one coupon's distribution, frozen on its first payment. A distribution is many `pay_coupon` transactions spread over time, and every input to the payout other than the holder's balance and the coupon period is mutable elsewhere (`set_payment_token`, `coupon::set_coupon_rate`, `bond::update_bond_terms`). Without this pin, holders of the same coupon could be paid in different currencies or at different rates depending on when their transaction landed.

- Created by `pay_coupon` via `init_if_needed` (rent paid by `payer`). On the call that creates it, the handler copies `payment_mint` / `payment_mint_decimals` from `treasury_config`, the effective rate (coupon override if both fields are `Some`, else `bond_terms`), `par_value` / `par_value_decimals` and the day-count (360 or 365) from `bond_terms`. A default `payment_mint` marks the account as not yet opened.
- Every later payment of the same coupon computes the amount **only** from these fields plus the coupon's period, and must pass the pinned `payment_mint` (`PaymentMintMismatch` otherwise). Changes to `treasury_config`, the coupon's override or `bond_terms` apply to coupons whose first payment happens afterwards.
- `paid_count` / `total_paid` are incremented on every payment, giving an on-chain reconciliation of the distribution.

### `CouponPaidMarker`

```rust
#[account]
pub struct CouponPaidMarker {
    pub bump: u8,
    pub amount: u64,
}
// LEN = 8 + 1 + 8 = 17 bytes
// Seeds: ["coupon_paid", mint, coupon_id.to_le_bytes(), holder]
```

One marker per `(mint, coupon_id, holder)` triple, where `holder` is the wallet the Merkle leaf commits to. Created via `init` inside `pay_coupon` — the second attempt to pay the same coupon to the same holder fails because the PDA already exists. Stores `amount` for off-chain auditing.

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
    PaymentDestinationMismatch,         // holder_payment_account.owner != holder
    PaymentMintMismatch,                // payment_mint != coupon_distribution.payment_mint
}
```

The Merkle-proof failure is **not** a treasury error: `pay_coupon` calls
`common::require_balance_proof`, which raises `common::CommonError::InvalidMerkleProof`
(the same shared helper pattern as `require_role` / `require_functionality`).

Access-control and state errors come from `common`: `MissingRole` / `RoleOutOfBounds` (role check), `FunctionalityNotSupportedError` / `FunctionalityOutOfBounds` / `AssetClassVersionNotFinalized` (functionality gate), and `MintPaused` / `Deactivated` (pause / deactivation).

Account-shape mismatches (wrong mint, wrong owner, wrong token program, wrong payment-mint key) surface as Anchor's built-in constraint errors and need no custom variants:

| Anchor error | Triggered by |
|---|---|
| `ConstraintTokenMint` | a token account's `mint` field doesn't match `payment_mint` |
| `ConstraintTokenOwner` | `treasury_token_account` is not owned by the `treasury_authority` PDA |
| `ConstraintTokenTokenProgram` | a token account or the mint is owned by a different token program than `token_program` |

---

## Instructions

### `set_payment_token()`

Sets (or replaces) the mint used to settle coupon payments for this bond mint.

- Creates `treasury_config` on the first call (`init_if_needed`); overwrites `payment_mint` / `payment_mint_decimals` on subsequent calls.
- Reads `payment_mint`'s decimals from its account data and caches them in `treasury_config`.
- The payment mint is **not** the bond mint — it's the mint used to pay interest (e.g. USDC, classic SPL or Token-2022).
- Can be called at any time, including while a coupon is being distributed: coupons already opened keep their pinned mint (`CouponDistribution`), so the new mint applies from the next coupon's first payment.

**Preconditions:** `require_role(ROLE_TREASURER)` → `require_not_paused` → `require_active` → `require_functionality(TREASURY_SET_PAYMENT_TOKEN)`.

**Accounts**

| # | Name | Notes |
|---|---|---|
| 0 | `payer` | Signer, mut. Funds rent for `treasury_config` on the first call. |
| 1 | `authority` | Signer. Must hold `ROLE_TREASURER` on this mint. |
| 2 | `asset_configuration_pda` | `Account<AssetConfiguration>`, owned by `deploy`. Seeds `["asset_configuration", mint]`. Used to derive `asset_class_version_pda`. |
| 3 | `mint_compliance_pda` | `AccountLoader<MintCompliance>`, owned by `transfer-hook`. Seeds `["mint_compliance", mint]`. `deactivated` must be 0 (verified by `require_active`). |
| 4 | `mint` | Bond's Token-2022 mint. Pause state checked by `require_not_paused`. |
| 5 | `treasury_config` | Owned by `treasury`. `init_if_needed`. Seeds `["treasury_config", mint]`. |
| 6 | `payment_mint` | `InterfaceAccount<Mint>` — classic SPL or Token-2022. Decimals read here. |
| 7 | `asset_class_version_pda` | `AccountLoader<AssetClassVersion>`, owned by `factory`. Seeds `["asset_class_version", config_id, version_id]`. Functionality gate. |
| 8 | `system_program` | — |
| 9 | `authority_roles_pda` | `AccountLoader<Roles>`, owned by `access-control`. Seeds `["roles", mint, authority]`. Read to verify `authority` holds `ROLE_TREASURER`. |
| 10 | `event_authority` | `#[event_cpi]`-injected PDA `["__event_authority"]`; signs the `PaymentTokenSet` self-CPI. |
| 11 | `program` | `#[event_cpi]`-injected; this program's own ID, target of the self-CPI. |

---

### `pay_coupon(coupon_id: u64, holder: Pubkey, balance: u64, merkle_proof: Vec<[u8; 32]>)`

Computes and pays the coupon to a single holder, into a payment-mint token account that holder owns.

**Arguments**

| Arg | Meaning |
|---|---|
| `coupon_id` | Which coupon is being paid. Seeds the `coupon`, `coupon_distribution` and `coupon_paid` PDAs. |
| `holder` | The **wallet** the balance is claimed for — the owner of the bond position at the record date. Seeds the `coupon_paid` marker, is the first half of the Merkle leaf preimage, and must own `holder_payment_account`. |
| `balance` | The holder's bond-mint balance at `coupon.snapshot_id`, in raw mint units, **summed over all of that wallet's bond token accounts**. **Caller-supplied but not trusted** — see the verification step below. |
| `merkle_proof` | Sibling hashes, leaf → root, proving `(account, balance)` belongs to the snapshot tree. Empty for a single-leaf tree. |

`holder` is an argument, not an account: the program never loads the holder's bond token account(s). Its binding to reality is the Merkle proof (a wallet that isn't a leaf of the snapshot tree cannot be paid) plus the owner check on the destination.

**Why the leaf is keyed by wallet, not by bond token account.** The leaf is what ties the payment to a person, so it must carry the identity the money goes to. Reading the owner of the bond token account at payment time would not work: the account may have been closed after the record date (the holder sold and reclaimed rent), and a non-ATA account may have changed owner via `SetAuthority`, so the live owner is not necessarily the record-date owner. Committing the wallet in the leaf freezes that identity at the snapshot. The off-chain tree builder therefore emits **one leaf per wallet**, with `balance` = the sum of that wallet's bond token accounts at the record date.

**Destination binding.** `holder_payment_account.owner` must equal `holder` (`PaymentDestinationMismatch` otherwise). Together with the proof, this means a `ROLE_TREASURER` signer decides only *when* a holder is paid — not to whom, how much, or in which mint. Any payment-mint token account owned by the holder is accepted (ATA or not); holders owned by a PDA (custodians, vaults) are paid into an account of that PDA.

**Order of operations:** account validation (incl. destination owner check) → `require_role(ROLE_TREASURER)` → `require_not_paused` → `require_active` → `require_functionality(TREASURY_PAY_COUPON)` → maturity gate → Merkle verification → pin `coupon_distribution` (first payment only) → payment-mint check against the pin → payout math → `transfer_checked` → distribution counters → marker write → `emit_cpi!`.

**Maturity gate**

After the precondition checks, the handler reads the cluster clock (`Clock::get()?.unix_timestamp`) and rejects with `CouponNotMature` if it has not yet reached `coupon.payment_date`. This prevents paying a coupon early.

**Balance verification**

```rust
require_balance_proof(&merkle_proof, snapshot_merkle_root.merkle_root, account, balance)?;
```

`require_balance_proof` is a thin `common` wrapper (mirroring `verify_control_list_pda`)
that calls the pure `merkle::verify_balance_proof` primitive and raises
`CommonError::InvalidMerkleProof` on failure — keeping the crypto primitive a
host-testable `bool` while matching the `require_*` convention.

- The root comes from the `snapshot_merkle_root` PDA of `coupon.snapshot_id` (seeds `["snapshot_merkle_root", mint, coupon.snapshot_id]`, owned by `snapshot`, written once and immutable by `take_snapshot`). Anchor derives that PDA from `coupon.snapshot_id` itself, so the caller cannot point the instruction at a different snapshot's root.
- The leaf is `keccak(holder || balance.to_le_bytes())` — 40 bytes. Internal nodes hash two 32-byte children (64 bytes). The differing preimage lengths are what stops an internal node from being replayed as a leaf; see the `// SECURITY:` note in `common::merkle`.
- The tree is **sorted-pair (commutative)**: each step hashes `min(computed, sibling) || max(computed, sibling)`, so no direction bits travel with the proof. The consequence is that only *leaf existence* is proven, never leaf position. That is sufficient here because the double-payment guard is the `coupon_paid` PDA, keyed by `(coupon_id, holder)` — position in the tree is irrelevant.
- Verification is pure computation on `Vec<[u8; 32]>`; proof length grows as `log2(holders)`, so a 1M-holder snapshot costs ~20 keccak syscalls.
- Off-chain, tests build leaves and roots with `tests/program_helpers/snapshot/merkle_helper.ts` (`leafHash` mirrors `common::merkle::leaf_hash` exactly); production callers must use the same encoding.

**Computation**

```
              interest_rate × balance × par_value × elapsed_seconds × 10^payment_mint_dec
amount  =  ─────────────────────────────────────────────────────────────────────────────────────
              10^interest_dec × 10^bond_mint_dec × 10^par_value_dec × day_count × 86_400
```

- `interest_rate`, `interest_dec`, `par_value`, `par_value_dec`, `day_count` and `payment_mint_dec` are read from `coupon_distribution`, i.e. the values pinned on the coupon's first payment. At pin time the rate is resolved as: the coupon's `interest_rate_override` / `interest_rate_override_decimals` if both are `Some`, otherwise `bond_terms.interest_rate` / `interest_rate_decimals`; `par_value`, `par_value_dec` and the day-count come from `bond_terms`, `payment_mint_dec` from `treasury_config`.
- `bond_mint_dec` is read directly from the bond `mint` (`InterfaceAccount<Mint>`).
- `coupon.snapshot_id`, `coupon.period_start_date`, `coupon.period_end_date`, and `coupon.payment_date` come from `coupon` (coupon, seeds `["coupon", mint, coupon_id]`).
- `balance` is supplied by the caller and **verified** against the snapshot's Merkle root via `common::require_balance_proof(&merkle_proof, snapshot_merkle_root.merkle_root, holder, balance)?` (see "Balance verification" above).
- `elapsed_seconds = coupon.period_end_date − coupon.period_start_date` — the accrual window of *this* coupon, not the time since bond issuance. Each coupon accrues independently. The non-positive case can't normally happen because `coupon::create_coupon` enforces strict `>`, but defence-in-depth: `NegativeElapsedTime` if it ever does.
- `day_count` is `360` or `365` per `bond_terms.day_count_convention` (Actual360 / Actual365).

**Why `10^bond_mint_dec` and `10^payment_mint_dec`.** `balance` is in raw bond-mint units, so dividing by `10^bond_mint_dec` converts it to "number of bonds". The result of the inner expression is in *real currency* (e.g. dollars); multiplying by `10^payment_mint_dec` converts it to raw payment-mint units suitable for `transfer_checked`. Without these factors the result is silently wrong as soon as the bond mint and payment mint don't share the same decimal count.

**Algebraic simplification used in the handler.** All four `10^…` factors collapse into one signed exponent

```
net_power = payment_mint_dec − (interest_dec + bond_mint_dec + par_value_dec)
```

applied to one side of the fraction (multiply numerator if `net_power ≥ 0`, multiply denominator by `10^|net_power|` otherwise). This keeps intermediate `u128` values smaller than the naive form — same precision, lower overflow risk. The division at the end is a single integer division (rounds toward zero). Anything that overflows `u128` or doesn't fit back into `u64` fails with `AmountOverflow`.

**Transfer**

`transfer_checked` via the **token interface** (`anchor_spl::token_interface::transfer_checked`) — dispatches through whichever token program owns the mint (classic SPL or Token-2022). Source: `treasury_token_account`. Destination: `holder_payment_account`. Signed by `treasury_authority` PDA via `invoke_signed`. The decimals argument is `coupon_distribution.payment_mint_decimals`.

**Distribution pin**

On the coupon's first payment `coupon_distribution` is created and filled (see the state section). On every payment the handler then requires `payment_mint == coupon_distribution.payment_mint` (`PaymentMintMismatch`), so late payers of an open coupon must be paid from the treasury account of the mint that coupon started with, even if `set_payment_token` has since pointed `treasury_config` elsewhere. After the transfer, `paid_count` is incremented and `amount` is added to `total_paid`.

**Double-payment guard**

The `coupon_paid` marker PDA is created via `init` (not `init_if_needed`) and keyed by `(coupon_id, holder)` — **not** `snapshot_id`, so the same snapshot can back several corporate actions independently. The second `pay_coupon` for the same `(coupon_id, holder)` fails to create the account and reverts the whole transaction — so the holder receives the coupon at most once.

**Accounts**

| # | Name | Notes |
|---|---|---|
| 0 | `payer` | Signer, mut. Funds rent for the `coupon_paid` marker. |
| 1 | `authority` | Signer. Must hold `ROLE_TREASURER` on this mint. |
| 2 | `asset_configuration_pda` | `Account<AssetConfiguration>`. Seeds `["asset_configuration", mint]`. Used to derive `asset_class_version_pda`. |
| 3 | `mint_compliance_pda` | `AccountLoader<MintCompliance>`. Seeds `["mint_compliance", mint]`. `deactivated` must be 0. |
| 4 | `mint` | Bond's Token-2022 mint, loaded as `InterfaceAccount<Mint>` so `decimals` is available for the payout math. Pause state checked by `require_not_paused` from the same account data. |
| 5 | `treasury_config` | Read-only. Seeds `["treasury_config", mint]`. Source of the payment mint pinned on a coupon's first payment. |
| 6 | `treasury_authority` | Empty PDA. Seeds `["treasury_authority", mint]`. Owner of `treasury_token_account`; signs the transfer via `invoke_signed`. |
| 7 | `payment_mint` | `InterfaceAccount<Mint>`. Anchor enforces `mint::token_program = token_program`; the handler requires it to equal `coupon_distribution.payment_mint` (`PaymentMintMismatch`). |
| 8 | `treasury_token_account` | **Source** of the transfer. `InterfaceAccount<TokenAccount>`, mut. Anchor enforces `token::mint = payment_mint`, `token::authority = treasury_authority`, `token::token_program = token_program`. |
| 9 | `holder_payment_account` | **Destination** of the transfer. `InterfaceAccount<TokenAccount>`, mut. Anchor enforces `token::mint = payment_mint`, `token::token_program = token_program`, and `owner == holder` (`PaymentDestinationMismatch`). |
| 10 | `bond_terms` | Read-only. Read for `interest_rate` / `interest_rate_decimals` (fallback), `par_value` / `par_value_decimals`, `day_count_convention`. Seeds `["bond_terms", mint]`, owned by `bond`. |
| 11 | `coupon` | Read-only. Read for `snapshot_id`, `payment_date`, `period_start_date` / `period_end_date`, and the optional `interest_rate_override`. Seeds `["coupon", mint, coupon_id]`, owned by `coupon`. |
| 12 | `snapshot_merkle_root` | `Account<SnapshotMerkleRoot>`, read-only, owned by `snapshot`. Seeds `["snapshot_merkle_root", mint, coupon.snapshot_id]`. Its `merkle_root` is the commitment the `(account, balance)` proof is checked against. |
| 13 | `coupon_paid` | `init`. Seeds `["coupon_paid", mint, coupon_id, holder]`. **The double-payment guard.** |
| 14 | `coupon_distribution` | `init_if_needed`, mut. Seeds `["coupon_distribution", mint, coupon_id]`. Pinned terms + counters for this coupon. |
| 15 | `asset_class_version_pda` | `AccountLoader<AssetClassVersion>`, owned by `factory`. Seeds `["asset_class_version", config_id, version_id]`. Functionality gate. |
| 16 | `token_program` | `Interface<TokenInterface>` — classic SPL or Token-2022. The mint and both token accounts must all be owned by this program. |
| 17 | `system_program` | — |
| 18 | `authority_roles_pda` | `AccountLoader<Roles>`, owned by `access-control`. Seeds `["roles", mint, authority]`. Read to verify `authority` holds `ROLE_TREASURER`. |
| 19 | `event_authority` | `#[event_cpi]`-injected PDA `["__event_authority"]`; signs the `CouponPaid` self-CPI. |
| 20 | `program` | `#[event_cpi]`-injected; this program's own ID, target of the self-CPI. |

Note there is **no** `holder_token_account` and **no** `snapshot_program` account — both existed while the balance was fetched by CPI and were dropped when the Merkle proof replaced it. Clients using `.accountsStrict()` must not pass them.

### A note on `Box<…>` in the accounts struct

In the Rust source, every `InterfaceAccount<…>` and `Account<…>` field above is wrapped in `Box<…>` (e.g. `Box<InterfaceAccount<'info, Mint>>`), with the sole exception of `asset_configuration_pda`. This is *not* a behavioural change — it's a fix for the BPF runtime's 4 KB per-call-frame stack limit.

By default Anchor materialises the deserialised struct **on the stack**. Two `Mint` + two `TokenAccount` + six `Account<…>` fields (`treasury_config`, `bond_terms`, `coupon`, `snapshot_merkle_root`, `coupon_paid`, `coupon_distribution`) stacked together push us past 4 KB → "access violation in stack frame" at validation time, before any handler logic runs. Boxing moves each deserialised payload to the heap and leaves only an 8-byte pointer on the stack. `Box<T>` auto-dereferences, so the handler reads `mint.decimals`, `cfg.payment_mint`, etc. exactly as if the fields weren't boxed.

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
    pub holder: Pubkey,       // wallet proven in the Merkle leaf
    pub destination: Pubkey,  // holder_payment_account that was credited
    pub balance: u64,         // proven record-date balance
    pub payment_mint: Pubkey,
    pub amount: u64,          // raw payment-mint units transferred
    pub payer: Pubkey,
}
```

`destination` is included so the event alone shows where each payment landed, without decoding the inner `transfer_checked`.

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
