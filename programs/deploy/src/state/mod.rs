use anchor_lang::prelude::*;
use common::state::{discriminators_eq, MintOwner as MintOwnerCommon};

/// Re-exports MintOwner with the `#[account]` attribute so that deploy can use
/// it as `Account<MintOwner>` (which requires the Owner trait provided by `#[account]`).
///
/// The type itself (fields, serialization) is defined in `common::state::MintOwner`
/// so downstream programs can deserialize it without importing deploy.
///
/// MIRROR: `common::state::MintOwner` holds the same fields without `#[account]`
/// so downstream programs can deserialize it without importing deploy.
/// Both definitions must stay in sync — the compile-time assertion below guards against
/// divergence by failing the build if the two structs ever differ in size.
#[account(discriminator = MintOwnerCommon::DISCRIMINATOR)]
#[derive(InitSpace)]
pub struct MintOwner {
    pub asset_class_config_id: u64,
    pub asset_class_version_id: u64,
    pub bump: u8,
}

const _: () = assert!(
    size_of::<MintOwner>() == size_of::<MintOwnerCommon>(),
    "deploy::MintOwner and common::MintOwner have diverged — update both structs together",
);

const _: () = assert!(
    discriminators_eq(
        <MintOwner as Discriminator>::DISCRIMINATOR,
        <MintOwnerCommon as Discriminator>::DISCRIMINATOR
    ),
    "deploy::MintOwner and common::MintOwner discriminators have diverged — update both together",
);
