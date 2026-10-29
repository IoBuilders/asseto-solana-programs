use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("effective_datetime must be greater than zero")]
    InvalidTimestamp,
    #[msg("effective_datetime must be strictly greater than the current effective_datetime")]
    EffectiveDatetimeNotAfterCurrent,
    #[msg("effective_datetime must be strictly in the past")]
    EffectiveDatetimeNotInPast,
    #[msg("effective_datetime must equal the current effective_datetime")]
    EffectiveDatetimeMismatch,
}
