use anchor_lang::prelude::*;

#[error_code]
pub enum TransferHookError {
    #[msg("Failed to compute extra account meta list size")]
    InvalidAccountSize,
}
