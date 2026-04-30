use anchor_lang::prelude::*;
use cmtat_common::state::MintOwner as MintOwnerData;

/// Re-exports MintOwner with the `#[account]` attribute so that cmtat-deploy can use
/// it as `Account<MintOwner>` (which requires the Owner trait provided by `#[account]`).
///
/// The type itself (fields, serialization) is defined in `cmtat-common::state::MintOwner`
/// so downstream programs can deserialize it without importing cmtat-deploy.
///
/// MIRROR: `cmtat-common::state::MintOwner` holds the same fields without `#[account]`
/// so downstream programs can deserialize it without importing cmtat-deploy.
/// Both definitions must stay in sync — the compile-time assertion below guards against
/// divergence by failing the build if the two structs ever differ in size.
#[account]
pub struct MintOwner {
    pub deployer: Pubkey,
    pub bump: u8,
}

impl MintOwner {
    pub const LEN: usize = MintOwnerData::LEN;
}

const _: () = assert!(
    core::mem::size_of::<MintOwner>() == core::mem::size_of::<MintOwnerData>(),
    "cmtat-deploy::MintOwner and cmtat-common::MintOwner have diverged — update both structs together",
);
