use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Coupon payment_date is earlier than bond issuance_date")]
    NegativeElapsedTime,
    #[msg("Computed coupon amount overflows u64")]
    AmountOverflow,
    #[msg("Coupon payment_date has not been reached yet")]
    CouponNotMature,
    #[msg("Payment token cannot be changed while claims are in progress for the current coupon")]
    ClaimsInProgress,
}
