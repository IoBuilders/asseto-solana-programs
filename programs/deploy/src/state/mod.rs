use anchor_lang::prelude::*;
use common::state::{discriminators_eq, AssetConfiguration as AssetConfigurationCommon};

/// Re-exports common's AssetConfiguration with the `#[account]` attribute so that
/// this program can initialize it.
///
/// The type itself (fields, serialization) is defined in `common::state::AssetConfiguration`
/// so downstream programs can deserialize it without importing deploy.
///
/// Both definitions must stay in sync — the compile-time assertion below guards against
/// divergence by failing the build if the two structs ever differ in size.
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
