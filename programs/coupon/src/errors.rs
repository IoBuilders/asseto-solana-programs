use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Supplied coupon_id does not match coupon_counter.count + 1")]
    InvalidCouponId,
    #[msg("period_end_date must be strictly greater than period_start_date")]
    InvalidCouponPeriod,
    #[msg("payment_date must be strictly greater than period_end_date")]
    InvalidPaymentDate,
}
