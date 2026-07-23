use anchor_lang::prelude::*;

#[error_code]
pub enum OperationsError {
    #[msg("Signer is not the owner of the source token account")]
    UnauthorizedTransfer,
    #[msg("The batch must contain at least one destination")]
    EmptyBatch,
    #[msg("Expected exactly one remaining accounts (destination) per destination")]
    InvalidRemainingAccounts,
}
