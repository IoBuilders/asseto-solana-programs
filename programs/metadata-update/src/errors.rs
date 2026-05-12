use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Metadata authority must be a signer")]
    MetadataAuthorityMustBeSigner,
}
