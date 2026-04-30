use anchor_lang::prelude::*;

/// Persists the deployer (mint owner) for a given mint.
/// Created by `cmtat-deploy` with seeds `["mint_owner", mint]`, owned by that program.
///
/// Defined in `cmtat-common` so all downstream programs can deserialize it without
/// importing `cmtat-deploy` (which would create circular dependencies).
///
/// Cannot use `#[account]` here because that macro requires `declare_id!` (i.e. a program
/// entry point), which a shared library crate does not have. `AnchorDeserialize` (Borsh)
/// is used instead; the discriminator bytes are skipped manually in `verify_deployer`.
/// The `seeds::program` constraint in every caller already guarantees we are reading the
/// correct account type, making the discriminator check redundant.
///
/// MIRROR: `cmtat-deploy::state::MintOwner` wraps the same fields with `#[account]` so
/// that `cmtat-deploy` can use `Account<MintOwner>`. Both definitions must stay in sync.
/// A compile-time size assertion in `cmtat-deploy/state/mod.rs` guards against divergence.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MintOwner {
    /// The wallet that deployed this mint and is recorded as its owner.
    pub deployer: Pubkey,
    /// Canonical bump for this PDA — saved to spare a find_program_address call.
    pub bump: u8,
}

impl MintOwner {
    pub const LEN: usize = 8  // discriminator
        + 32                  // deployer
        + 1;                  // bump
}
