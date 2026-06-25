use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Supplied coupon_id does not match coupon_counter.count + 1")]
    InvalidCouponId,
    #[msg("period_end_date must be strictly greater than period_start_date")]
    InvalidCouponPeriod,
    #[msg("payment_date must be strictly greater than period_end_date")]
    InvalidPaymentDate,
    #[msg("interest_rate_override and interest_rate_override_decimals must both be Some or both be None")]
    InconsistentRateOverride,
    #[msg("coupon counter overflow when creating new coupon")]
    CouponCounterOverflow,
}
