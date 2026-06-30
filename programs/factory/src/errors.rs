use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Signer is not the current factory manager")]
    NotManager,
    #[msg("Signer is not the pending manager")]
    NotPendingManager,
    #[msg("Factory is paused")]
    FactoryPaused,
}
