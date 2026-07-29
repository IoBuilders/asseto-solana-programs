use anchor_lang::prelude::*;

#[error_code]
pub enum OperationsError {
    #[msg("The batch must contain at least one destination")]
    EmptyBatch,
    #[msg("Expected exactly one remaining accounts (destination) per destination")]
    InvalidRemainingAccounts,
}
