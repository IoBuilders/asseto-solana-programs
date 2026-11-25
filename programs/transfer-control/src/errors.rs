use anchor_lang::prelude::*;

#[error_code]
pub enum TransferControlError {
    #[msg("The transfer mode has already been set for this mint")]
    TransferModeAlreadySet,
    #[msg("The account is not in the control list")]
    AccountNotInControlList,
}
