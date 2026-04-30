use anchor_lang::prelude::*;

#[error_code]
pub enum CmtatTransferControlError {
    #[msg("The account is not whitelisted")]
    NotWhitelisted,
}
