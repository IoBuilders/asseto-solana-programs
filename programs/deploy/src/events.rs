use anchor_lang::prelude::*;

/// Emitted once per successful `deploy_mint`, after all extensions, authorities
/// and the transfer-hook metadata list have been initialized.
#[event]
pub struct MintDeployed {
    pub mint: Pubkey,
    pub deployer: Pubkey,
    pub decimals: u8,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    /// Taken from the `additional_metadata` entry keyed `"isin"`, if present.
    pub isin: Option<String>,
}
