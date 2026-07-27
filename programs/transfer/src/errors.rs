use anchor_lang::prelude::*;

#[error_code]
pub enum TransferError {
    #[msg("Signer is not the owner of the source token account")]
    UnauthorizedTransfer,
    #[msg("The batch must contain at least one destination")]
    EmptyBatch,
    #[msg("Expected exactly one remaining account (destination) per amount for transfer, or two (destination + whitelist PDA) per amount for verify")]
    InvalidRemainingAccounts,
    #[msg("The sum of the batch amounts overflows u64")]
    BatchAmountOverflow,
}
