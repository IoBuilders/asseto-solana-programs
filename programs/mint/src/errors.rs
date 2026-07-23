use anchor_lang::prelude::*;

#[error_code]
pub enum MintError {
    #[msg("The batch must contain at least one destination")]
    EmptyBatch,
    #[msg("Expected exactly two remaining accounts (destination + whitelist PDA) per destination")]
    InvalidRemainingAccounts,
}
