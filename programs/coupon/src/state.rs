use anchor_lang::prelude::*;

/// Per-mint counter that produces strictly-increasing coupon ids. Created on
/// the first `create_coupon` call (`init_if_needed`), incremented thereafter.
/// Seeds: `["coupon_counter", mint]`.
#[account]
#[derive(InitSpace)]
pub struct CouponCounter {
    pub bump: u8,
    pub count: u64,
}

/// One coupon record per `(mint, coupon_id)`.
///
/// Each coupon represents the interest accrued over a fixed period, plus the
/// date on which that interest can be paid out to holders:
/// - `period_start_date` / `period_end_date` define the accrual window. The
///   payout amount in `treasury::pay_coupon` is proportional to
///   `period_end_date − period_start_date` — *not* to the time since bond
///   issuance, so successive coupons accrue independently rather than
///   cumulatively.
/// - `payment_date` is when the treasury is allowed to pay this coupon
///   (typically `period_end_date` + a settlement lag). Strictly after
///   `period_end_date`. The treasury's maturity check gates on this field.
///
/// `snapshot_id` records the snapshot index taken at creation time, used to
/// recover holder balances and total supply at the coupon's record date.
///
/// `interest_rate_override` / `interest_rate_override_decimals` are both
/// `None` by default — `treasury::pay_coupon` then falls back to the
/// asset-level rate in `bond_terms`. When set (via `set_coupon_rate`), they
/// replace the bond-level rate **only for this coupon**, using the same
/// scaling convention as `BondTerms`: actual rate = rate / 10^decimals.
///
/// Seeds: `["coupon", mint, coupon_id.to_le_bytes()]`.
#[account]
#[derive(InitSpace)]
pub struct Coupon {
    pub bump: u8,
    pub snapshot_id: u64,
    pub period_start_date: i64,
    pub period_end_date: i64,
    pub payment_date: i64,
    pub interest_rate_override: Option<u64>,
    pub interest_rate_override_decimals: Option<u8>,
}

impl Coupon {
    /// Sets (or clears) the coupon-level interest rate override.
    ///
    /// Both `rate` and `decimals` must be either both `Some` or both `None`;
    /// mixed values are rejected with `InconsistentRateOverride`.
    pub fn set_interest_rate(&mut self, rate: Option<u64>, decimals: Option<u8>) -> Result<()> {
        require!(
            rate.is_some() == decimals.is_some(),
            crate::errors::ErrorCode::InconsistentRateOverride
        );
        self.interest_rate_override = rate;
        self.interest_rate_override_decimals = decimals;
        Ok(())
    }
}
