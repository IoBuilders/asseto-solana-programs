use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Mint authority must be a signer")]
    MintAuthorityMustBeSigner,
    #[msg("Failed to calculate mint account size for the requested extensions")]
    InvalidMintAccountSize,
}
