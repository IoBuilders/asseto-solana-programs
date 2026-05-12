use anchor_lang::prelude::*;

/// Per-mint counter that produces strictly-increasing coupon ids. Created on
/// the first `create_coupon` call (`init_if_needed`), incremented thereafter.
/// Seeds: `["coupon_counter", mint]`.
#[account]
pub struct CouponCounter {
    pub bump: u8,
    pub count: u64,
}

impl CouponCounter {
    // 8 (discriminator) + 1 (bump) + 8 (count)
    pub const LEN: usize = 8 + 1 + 8;
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
/// Seeds: `["coupon", mint, coupon_id.to_le_bytes()]`.
#[account]
pub struct Coupon {
    pub bump: u8,
    pub snapshot_id: u64,
    pub period_start_date: i64,
    pub period_end_date: i64,
    pub payment_date: i64,
}

impl Coupon {
    // 8 (discriminator) + 1 (bump) + 8 (snapshot_id)
    // + 8 (period_start_date) + 8 (period_end_date) + 8 (payment_date)
    pub const LEN: usize = 8 + 1 + 8 + 8 + 8 + 8;
}
