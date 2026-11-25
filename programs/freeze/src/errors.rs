use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Mint authority or Operations authority must be a signer")]
    Unauthorized,
    #[msg("The batch must contain at least one account")]
    EmptyBatch,
    #[msg("Expected exactly two remaining accounts per entry")]
    InvalidRemainingAccounts,
    #[msg("Account is not frozen")]
    AccountNotFrozen,
    #[msg("Account is not partially frozen")]
    AccountNotPartiallyFrozen,
    #[msg("A partial freeze must lock a non-zero amount")]
    InvalidFreezeAmount,
}
