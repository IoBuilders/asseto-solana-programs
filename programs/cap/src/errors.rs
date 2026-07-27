use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Max supply must be at least 1")]
    MaxSupplyTooLow,
    #[msg("Max supply cannot be lower than the mint's current total supply")]
    MaxSupplyBelowTotalSupply,
    #[msg("Minting this amount would push the total supply past the max supply")]
    MaxSupplyExceeded,
}
