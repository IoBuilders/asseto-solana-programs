use anchor_lang::prelude::*;

#[error_code]
pub enum TransferHookError {
    #[msg("Failed to compute extra account meta list size")]
    InvalidAccountSize,
    #[msg("transfer-hook execute was invoked outside of a Token-2022 transfer")]
    NotTransferring,
}
