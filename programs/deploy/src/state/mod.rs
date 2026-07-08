use anchor_lang::prelude::*;
use common::state::MintOwner as MintOwnerData;

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
#[account]
#[derive(InitSpace)]
pub struct MintOwner {
    pub deployer: Pubkey,
    pub asset_class_config_id: u64,
    pub asset_class_version_id: u64,
    pub bump: u8,
}

const _: () = assert!(
    core::mem::size_of::<MintOwner>() == core::mem::size_of::<MintOwnerData>(),
    "deploy::MintOwner and common::MintOwner have diverged — update both structs together",
);
