use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Hold amount must be greater than zero")]
    ZeroAmount,
    #[msg("Hold expiration must be in the future")]
    ExpirationInThePast,
    #[msg("Hold id does not match the next id for this position")]
    HoldIdMismatch,
    #[msg("Balance available after existing liens does not cover the hold amount")]
    InsufficientAvailableBalance,
    #[msg("Signer is not the escrow of this hold")]
    NotTheEscrow,
    #[msg("Hold is no longer active")]
    HoldNotActive,
    #[msg("Hold has expired")]
    HoldExpired,
    #[msg("Hold has not expired yet")]
    HoldNotExpired,
    #[msg("Amount exceeds the hold's remaining amount")]
    AmountExceedsHold,
    #[msg("Destination does not match the one pinned at hold creation")]
    DestinationMismatch,
    #[msg("Held amount is inconsistent with the hold being resolved")]
    HeldAmountUnderflow,
}
