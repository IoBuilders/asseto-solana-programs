use anchor_lang::prelude::*;

/// Persists the deployer (mint owner) for a given mint.
/// Created by `deploy` with seeds `["mint_owner", mint]`, owned by that program.
///
/// Defined in `common` so all downstream programs can deserialize it without
/// importing `deploy` (which would create circular dependencies).
///
/// Cannot use `#[account]` here because that macro requires `declare_id!` (i.e. a program
/// entry point), which a shared library crate does not have. `AnchorDeserialize` (Borsh)
/// is used instead; the discriminator bytes are skipped manually in `verify_deployer`.
/// The `seeds::program` constraint in every caller already guarantees we are reading the
/// correct account type, making the discriminator check redundant.
///
/// MIRROR: `deploy::state::MintOwner` wraps the same fields with `#[account]` so
/// that `deploy` can use `Account<MintOwner>`. Both definitions must stay in sync.
/// A compile-time size assertion in `deploy/state/mod.rs` guards against divergence.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct MintOwner {
    /// The wallet that deployed this mint and is recorded as its owner.
    pub deployer: Pubkey,
    /// Asset-class config id. First half of the seed that derives the factory
    /// asset-class PDA (`["asset_class", config_id, version_id]`, owned by
    /// `factory`) this mint is hooked to.
    pub asset_class_config_id: u64,
    /// Asset-class version id. Second half of the asset-class PDA seed.
    /// May be updated by the deployer when the mint is re-pointed to a newer
    /// asset-class version.
    pub asset_class_version_id: u64,
    /// Canonical bump for this PDA — saved to spare a find_program_address call.
    pub bump: u8,
}
