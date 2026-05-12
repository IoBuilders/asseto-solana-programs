use anchor_lang::prelude::*;

#[error_code]
pub enum TransferControlError {
    #[msg("The account is not whitelisted")]
    NotWhitelisted,
}
