use anchor_lang::prelude::*;

#[error_code]
pub enum TransferError {
    #[msg("Signer is not the owner of the source token account")]
    UnauthorizedTransfer,
    #[msg("No active transfer control mode was satisfied")]
    TransferControlDenied,
}
