use anchor_lang::prelude::*;

#[error_code]
pub enum CmtatOperationsError {
    #[msg("Signer is not the owner of the source token account")]
    UnauthorizedTransfer,
}
