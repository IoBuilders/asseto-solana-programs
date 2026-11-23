use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Coupon payment_date is earlier than bond issuance_date")]
    NegativeElapsedTime,
    #[msg("Computed coupon amount overflows u64")]
    AmountOverflow,
    #[msg("Coupon payment_date has not been reached yet")]
    CouponNotMature,
    #[msg("holder_payment_account is not owned by the holder proven in the Merkle leaf")]
    PaymentDestinationMismatch,
    #[msg("payment_mint differs from the payment mint pinned for this coupon's distribution")]
    PaymentMintMismatch,
}
