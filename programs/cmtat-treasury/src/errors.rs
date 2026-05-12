use anchor_lang::prelude::*;

/// Treasury-specific errors. Account-shape mismatches (wrong mint / wrong
/// owner / wrong token program) surface as Anchor's built-in constraint
/// errors (`ConstraintAddress`, `ConstraintTokenMint`, `ConstraintTokenOwner`,
/// `ConstraintTokenTokenProgram`) — no custom variants needed for those.
#[error_code]
pub enum ErrorCode {
    #[msg("Coupon payment_date is earlier than bond issuance_date")]
    NegativeElapsedTime,
    #[msg("Computed coupon amount overflows u64")]
    AmountOverflow,
    #[msg("Coupon payment_date has not been reached yet")]
    CouponNotMature,
}
