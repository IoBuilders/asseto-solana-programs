use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Mint authority or Operations authority must be a signer")]
    Unauthorized,
    #[msg("The account has been frozen")]
    AccountFrozen,
    #[msg("Transfer amount exceeds available (unfrozen) balance")]
    InsufficientUnfrozenBalance,
}
