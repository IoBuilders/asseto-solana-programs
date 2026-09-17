use anchor_lang::prelude::*;

#[event]
pub struct FactoryInitialized {
    pub manager: Pubkey,
}

#[event]
pub struct AssetClassCreated {
    pub config_id: u64,
    pub owner: Pubkey,
    pub manager: Pubkey,
}

#[event]
pub struct AssetClassVersionInitialized {
    pub config_id: u64,
    pub version: u64,
    pub owner: Pubkey,
}

#[event]
pub struct AssetClassVersionFunctionalitiesEnabled {
    pub config_id: u64,
    pub version: u64,
    pub functionalities: Vec<u16>,
    pub owner: Pubkey,
}

#[event]
pub struct AssetClassVersionFinalized {
    pub config_id: u64,
    pub version: u64,
    pub owner: Pubkey,
}
