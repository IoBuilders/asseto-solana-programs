use anchor_lang::prelude::*;
use common::state::{discriminators_eq, AssetConfiguration as AssetConfigurationCommon};

// Mirrors `common::state::AssetConfiguration` field-for-field, wrapped with
// `#[account]` so this program can initialize/write it; the asserts below
// enforce the two definitions never diverge.
#[account(discriminator = AssetConfigurationCommon::DISCRIMINATOR)]
#[derive(InitSpace)]
pub struct AssetConfiguration {
    pub asset_class_config_id: u64,
    pub asset_class_version_id: u64,
    pub bump: u8,
}

const _: () = assert!(
    size_of::<AssetConfiguration>() == size_of::<AssetConfigurationCommon>(),
    "deploy::AssetConfiguration and common::AssetConfiguration have diverged — update both structs together",
);

const _: () = assert!(
    discriminators_eq(
        <AssetConfiguration as Discriminator>::DISCRIMINATOR,
        <AssetConfigurationCommon as Discriminator>::DISCRIMINATOR
    ),
    "deploy::AssetConfiguration and common::AssetConfiguration discriminators have diverged — update both together",
);
