use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Mint authority or Operations authority must be a signer")]
    Unauthorized,
    #[msg("The account has been frozen")]
    AccountFrozen,
    #[msg("Transfer amount exceeds available (unfrozen) balance")]
    InsufficientUnfrozenBalance,
    #[msg("The batch must contain at least one account")]
    EmptyBatch,
    #[msg("Expected exactly two remaining accounts per entry")]
    InvalidRemainingAccounts,
    #[msg("Provided frozen_account_pda does not match the derived PDA for this account")]
    FrozenAccountPdaMismatch,
    #[msg("Provided frozen_balance_pda does not match the derived PDA for this account")]
    FrozenBalancePdaMismatch,
}
