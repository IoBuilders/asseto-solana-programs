use anchor_lang::prelude::*;

#[error_code]
pub enum PauseError {
    #[msg("Mint is already paused")]
    AlreadyPaused,
    #[msg("Mint is not paused")]
    NotPaused,
}
