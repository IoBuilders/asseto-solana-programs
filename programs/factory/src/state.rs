use anchor_lang::prelude::*;
use common::state::{
    discriminators_eq, AssetClassVersion as AssetClassVersionCommon, FUNCTIONALITIES_BYTES_MASK,
};

#[account]
#[derive(Debug, InitSpace)]
pub struct Factory {
    pub manager: Pubkey,
    pub pause: bool,
    pub bump: u8,
}

#[account]
#[derive(Debug, InitSpace)]
pub struct FactoryPendingManager {
    pub pending_manager: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(Debug, InitSpace)]
pub struct AssetClassOwnership {
    pub owner: Pubkey,
    pub latest_version: u64,
    pub bump: u8,
}

#[account]
#[derive(Debug, InitSpace)]
pub struct AssetClassPendingOwner {
    pub pending_owner: Pubkey,
    pub bump: u8,
}

#[account(zero_copy, discriminator = AssetClassVersionCommon::DISCRIMINATOR)]
#[repr(C)]
pub struct AssetClassVersion {
    pub config_id: u64,
    pub version: u64,
    pub state: u8,
    pub bump: u8,
    // see common/src/state/asset_class_version.rs for the reasoning of this field.
    pub _padding: [u8; 6],
    pub mask: [u8; FUNCTIONALITIES_BYTES_MASK],
}

const _: () = assert!(
    size_of::<AssetClassVersion>() == size_of::<AssetClassVersionCommon>(),
    "factory::AssetClassVersion and common::state::AssetClassVersion have diverged — update both together",
);

const _: () = assert!(
    discriminators_eq(
        <AssetClassVersion as Discriminator>::DISCRIMINATOR,
        <AssetClassVersionCommon as Discriminator>::DISCRIMINATOR
    ),
    "factory::AssetClassVersion and common::AssetClassVersion discriminators have diverged — update both together",
);
