use crate::CommonError::InvalidMintOwnerData;
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

impl Discriminator for MintOwner {
    /// The 8-byte Anchor account discriminator for `deploy::state::MintOwner`
    /// Computed here since this crate has no `declare_id!`/`#[account]` to derive it from
    /// Defined in `common` so all downstream programs can deserialize it
    const DISCRIMINATOR: &'static [u8] = &[15, 79, 132, 40, 8, 129, 114, 149];
}

// Defines the owner program of the Account<MintOwner>
impl Owner for MintOwner {
    fn owner() -> Pubkey {
        crate::program_ids::DEPLOY_PROGRAM_ID
    }
}

impl AccountDeserialize for MintOwner {
    fn try_deserialize(buf: &mut &[u8]) -> Result<Self> {
        // Check that the passed account's discriminator matches the targeted one
        if buf.len() < Self::DISCRIMINATOR.len() {
            return Err(ErrorCode::AccountDiscriminatorNotFound.into());
        }
        let given_disc = &buf[..Self::DISCRIMINATOR.len()];
        if given_disc != Self::DISCRIMINATOR {
            return Err(ErrorCode::AccountDiscriminatorMismatch.into());
        }
        Self::try_deserialize_unchecked(buf)
    }

    fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self> {
        // Skip the first discriminator bytes and deserialize the rest of the buffer.
        MintOwner::deserialize(&mut &buf[Self::DISCRIMINATOR.len()..])
            .map_err(|_| error!(InvalidMintOwnerData))
    }
}

// No-op: We can't write to another program's account.
impl AccountSerialize for MintOwner {}
