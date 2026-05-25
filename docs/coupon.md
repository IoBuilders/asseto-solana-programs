# coupon — Program Reference

Program ID: `CGQMgamBMtJ97CCMwVD9v5vAYVzFsXLy8beN8Ej6t3FK`

Issues coupons for a bond mint. Every coupon is anchored to a snapshot taken at issuance time, so holder balances at the coupon's record date are recoverable from `snapshot`.

`create_coupon` is the **sole entry point** that triggers a snapshot in this workspace — `snapshot::take_snapshot` is now an auxiliary instruction, callable only by the `coupon_authority` PDA owned by this program.

---

## State

### `CouponCounter`

```rust
#[account]
pub struct CouponCounter {
    pub bump: u8,
    pub count: u64,
}
// LEN = 8 + 1 + 8 = 17 bytes
// Seeds: ["coupon_counter", mint]
```

Per-mint counter that produces strictly-increasing coupon ids. Created on the first `create_coupon` call (`init_if_needed`) with `count = 1`; incremented by 1 on every subsequent call. The current id is therefore always `>= 1` whenever the PDA exists.

### `Coupon`

```rust
#[account]
pub struct Coupon {
    pub bump: u8,
    pub snapshot_id: u64,
    pub period_start_date: i64,
    pub period_end_date: i64,
    pub payment_date: i64,
    pub interest_rate_override: Option<u64>,
    pub interest_rate_override_decimals: Option<u8>,
}
// LEN = 8 + 1 + 8 + 8 + 8 + 8 + (1+8) + (1+1) = 52 bytes
// Seeds: ["coupon", mint, coupon_id.to_le_bytes()]
```

One per `(mint, coupon_id)`. Stores:
- `snapshot_id` — the snapshot index returned by the `take_snapshot` CPI run during this `create_coupon`. Use it with `snapshot`'s `get_holderbalance_snapshot_at` / `get_totalsupply_snapshot_at` to reconstruct who held what at the coupon's record date.
- `period_start_date` / `period_end_date` — the accrual window for *this* coupon. `treasury::pay_coupon` computes the payout from `period_end_date − period_start_date` so successive coupons accrue independently rather than cumulatively from issuance. The handler validates `period_end_date > period_start_date`; the program does **not** enforce that consecutive coupons chain (i.e. that coupon N's `period_start_date == coupon (N−1)'s period_end_date`) — the deployer is trusted to set consistent windows.
- `payment_date` — Unix timestamp (seconds) when the treasury is allowed to pay this coupon (typically `period_end_date` plus a settlement lag). Strictly greater than `period_end_date`; that's the only invariant enforced here. `treasury`'s maturity check then gates `pay_coupon` on `now ≥ payment_date`.
- `interest_rate_override` / `interest_rate_override_decimals` — optional per-coupon interest rate. Both are `None` on creation. When set via `set_coupon_rate`, `treasury::pay_coupon` uses them instead of the asset-level rate from `bond_terms`. Same scaling convention: actual rate = `interest_rate_override / 10^interest_rate_override_decimals`. If only one of the two is `Some`, the override is ignored and the fallback applies.

In steady state `snapshot_id == coupon_id` because coupon and snapshot counters increment in lockstep (coupons are the only producer of snapshots). They're stored as two separate counters anyway to keep the semantics decoupled — should the workspace ever expose a non-coupon snapshot path, existing coupon records remain interpretable.

---

## Error Codes

```rust
pub enum ErrorCode {
    InvalidCouponId,          // supplied coupon_id != coupon_counter.count + 1
    InvalidCouponPeriod,      // period_end_date <= period_start_date
    InvalidPaymentDate,       // payment_date <= period_end_date
    InconsistentRateOverride, // exactly one of the two rate-override fields is Some
}
```

`InconsistentRateOverride` is raised by both `create_coupon` and `set_coupon_rate`. Pause / deactivate / unauthorised-deployer errors come from `common` (`MintPaused`, `Deactivated`, `UnauthorizedDeployer`).

Pause / deactivate / unauthorised-deployer errors come from `common` (`MintPaused`, `Deactivated`, `UnauthorizedDeployer`).

---

## Instruction: `create_coupon` (Management)

### Parameters

```rust
period_start_date:               i64
period_end_date:                 i64
payment_date:                    i64
coupon_id:                       u64
interest_rate_override:          Option<u64>
interest_rate_override_decimals: Option<u8>
```

`coupon_id` is supplied by the client because Anchor's `init` constraint needs it at macro-evaluation time to derive the `coupon` PDA seeds. The handler re-checks it: `coupon_id` must equal `coupon_counter.count + 1` (or `1` on the first call). The client computes this by reading `coupon_counter.count` (or assuming the counter doesn't exist yet).

The three dates must satisfy `period_start_date < period_end_date < payment_date` (strict). No cross-coupon validation — the deployer chooses arbitrary windows.

`interest_rate_override` / `interest_rate_override_decimals` are optional. Pass `None` for both to inherit the asset-level rate from `bond_terms` (default). Pass `Some` for both to pin a coupon-specific rate — `treasury::pay_coupon` will use it instead of `bond_terms`. Passing `Some` for one and `None` for the other is rejected with `InconsistentRateOverride`. The rate can also be set or updated after creation via `set_coupon_rate`.

### Preconditions

- `verify_deployer` — only the deployer recorded in `mint_owner_pda` may call.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not have been deactivated.

### Execution

1. Run the three precondition checks.
2. Validate `period_end_date > period_start_date` (else `InvalidCouponPeriod`) and `payment_date > period_end_date` (else `InvalidPaymentDate`).
3. Validate that `interest_rate_override` and `interest_rate_override_decimals` are both `Some` or both `None` (else `InconsistentRateOverride`).
4. Increment `coupon_counter` (initialise to 1 on the first call, `+1` thereafter). Verify `coupon_id` matches.
5. CPI `snapshot::take_snapshot`, signed by the `coupon_authority` PDA via `invoke_signed`. Passes through `payer`, `mint`, and `snapshot_counter`.
6. Re-borrow `snapshot_counter` data and Borsh-deserialise `SnapshotCounter` to read the freshly-written snapshot id.
7. Write the new `Coupon` PDA with `bump`, `snapshot_id`, `period_start_date`, `period_end_date`, `payment_date`, `interest_rate_override`, `interest_rate_override_decimals`.

### Accounts

| Account            | Mut | Signer | Type                     | Notes                                                                                                  |
|--------------------|-----|--------|--------------------------|--------------------------------------------------------------------------------------------------------|
| `payer`            | yes | yes    | Signer                   | Funds `coupon_counter` (first call), `coupon` (always), and `snapshot_counter` (on the first snapshot) |
| `deployer`         | no  | yes    | Signer                   | Authorisation target for `verify_deployer`                                                             |
| `mint_owner_pda`   | no  | no     | UncheckedAccount         | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`                                     |
| `deactivate_pda`   | no  | no     | UncheckedAccount         | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty                  |
| `mint`             | no  | no     | UncheckedAccount         | Read-only; pause state checked by `require_not_paused`                                                 |
| `coupon_authority` | no  | no     | UncheckedAccount         | seeds `["coupon_authority", mint]`; signs the `take_snapshot` CPI via `invoke_signed`                  |
| `coupon_counter`   | yes | no     | `Account<CouponCounter>` | `init_if_needed`; seeds `["coupon_counter", mint]`, `payer = payer`                                    |
| `coupon`           | yes | no     | `Account<Coupon>`        | `init`; seeds `["coupon", mint, coupon_id.to_le_bytes()]`, `payer = payer`                             |
| `snapshot_counter` | yes | no     | UncheckedAccount         | seeds `["snapshot_counter", mint]`, `seeds::program = SNAPSHOT_PROGRAM_ID`; passed through to the CPI  |
| `snapshot_program` | no  | no     | UncheckedAccount         | Address-pinned to `SNAPSHOT_PROGRAM_ID`                                                                |
| `system_program`   | no  | no     | Program<System>          |                                                                                                        |

---

## Instruction: `set_coupon_rate` (Management)

Overrides the interest rate for a single already-issued coupon. By default every coupon inherits the asset-level rate from `bond_terms` when `treasury::pay_coupon` runs. Calling this instruction stores a coupon-specific rate that `pay_coupon` will use instead.

Calling the instruction again replaces the previous values. There is no reset path — if the coupon must revert to the asset-level rate, re-issue it.

### Parameters

```rust
coupon_id:               u64   // identifies which coupon to update (seed derivation)
interest_rate:           u64   // numerator of the annual rate
interest_rate_decimals:  u8    // exponent: actual rate = interest_rate / 10^interest_rate_decimals
```

Same scaling convention as `BondTerms`. Example: 5.275 % → `interest_rate = 5275`, `interest_rate_decimals = 5`.

### Preconditions

- `verify_deployer` — only the deployer recorded in `mint_owner_pda` may call.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not have been deactivated.

### Execution

1. Run the three precondition checks.
2. Set `coupon.interest_rate_override = Some(interest_rate)` and `coupon.interest_rate_override_decimals = Some(interest_rate_decimals)`.

### Accounts

| Account          | Mut | Signer | Type              | Notes                                                                                 |
|------------------|-----|--------|-------------------|---------------------------------------------------------------------------------------|
| `deployer`       | no  | yes    | Signer            | Authorisation target for `verify_deployer`                                            |
| `mint_owner_pda` | no  | no     | UncheckedAccount  | seeds `["mint_owner", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`                    |
| `deactivate_pda` | no  | no     | UncheckedAccount  | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint`           | no  | no     | UncheckedAccount  | Read-only; pause state checked by `require_not_paused`                                |
| `coupon`         | yes | no     | `Account<Coupon>` | seeds `["coupon", mint, coupon_id.to_le_bytes()]`; must already exist                 |

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.

---

## Reading coupons

External readers (other on-chain programs or off-chain clients) load coupons directly:

```rust
// On-chain
use coupon::state::Coupon;

#[account(
    seeds = [b"coupon", mint.key().as_ref(), &coupon_id.to_le_bytes()],
    seeds::program = coupon::ID,
    bump = coupon.bump,
)]
pub coupon: Account<'info, Coupon>,
```

```ts
// Off-chain
const coupon = await couponProgram.account.coupon.fetch(couponPda);
console.log(
  coupon.snapshotId.toString(),
  coupon.periodStartDate.toString(),
  coupon.periodEndDate.toString(),
  coupon.paymentDate.toString(),
);
```

To enumerate coupons for a mint, read `coupon_counter.count` and iterate `1..=count` deriving each `coupon` PDA from the seeds.
