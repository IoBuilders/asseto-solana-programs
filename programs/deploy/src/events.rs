use anchor_lang::prelude::*;

#[event]
pub struct MintDeployed {
    pub mint: Pubkey,
    pub deployer: Pubkey,
    pub decimals: u8,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub isin: Option<String>,
    pub asset_class_config_id: u64,
    pub asset_class_version_id: u64,
}
