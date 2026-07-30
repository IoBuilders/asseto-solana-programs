use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Document URI must not be empty")]
    EmptyUri,
}
