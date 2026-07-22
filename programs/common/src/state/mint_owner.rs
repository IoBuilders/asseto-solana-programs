use crate::CommonError::InvalidMintOwnerData;
use anchor_lang::prelude::*;

/// Byte offset of `MintOwner::asset_class_config_id` within the account data.
/// Derived from the fields that precede it in declaration order
pub const ASSET_CLASS_CONFIG_ID_OFFSET: u8 = MintOwner::DISCRIMINATOR.len() as u8;

/// Byte offset of `MintOwner::asset_class_version_id` within the account data —
/// immediately after `asset_class_config_id: u64`.
pub const ASSET_CLASS_VERSION_ID_OFFSET: u8 = ASSET_CLASS_CONFIG_ID_OFFSET + size_of::<u64>() as u8;

/// Persists the configuration for a given mint.
/// Created by `deploy` with seeds `["mint_owner", mint]`, owned by that program.
///
/// Defined in `common` so all downstream programs can deserialize it without
/// importing `deploy` (which would create circular dependencies).
///
/// MIRROR: `deploy::state::MintOwner` wraps the same fields with `#[account]` so
/// that `deploy` can use `Account<MintOwner>`. Both definitions must stay in sync.
/// A compile-time size assertion in `deploy/state/mod.rs` guards against divergence.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct MintOwner {
    /// Asset-class config id. First half of the seed that derives the factory
    /// asset-class PDA (`["asset_class", config_id, version_id]`, owned by
    /// `factory`) this mint is hooked to.
    pub asset_class_config_id: u64,
    /// Asset-class version id. Second half of the asset-class PDA seed.
    /// May be updated when the mint is re-pointed to a newer asset-class version.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards `ASSET_CLASS_CONFIG_ID_OFFSET` / `ASSET_CLASS_VERSION_ID_OFFSET`
    /// against `MintOwner` ever changing field order/types
    #[test]
    fn mint_owner_offsets_match_actual_layout() {
        let mint_owner = MintOwner {
            asset_class_config_id: 0x1122_3344_5566_7788,
            asset_class_version_id: 0x99AA_BBCC_DDEE_FF00,
            bump: 7,
        };

        let mut data = MintOwner::DISCRIMINATOR.to_vec();
        mint_owner.serialize(&mut data).unwrap();

        let config_id_start = ASSET_CLASS_CONFIG_ID_OFFSET as usize;
        let config_id_bytes: [u8; 8] = data[config_id_start..config_id_start + 8]
            .try_into()
            .unwrap();
        assert_eq!(
            u64::from_le_bytes(config_id_bytes),
            mint_owner.asset_class_config_id,
            "ASSET_CLASS_CONFIG_ID_OFFSET no longer points at asset_class_config_id"
        );

        let version_id_start = ASSET_CLASS_VERSION_ID_OFFSET as usize;
        let version_id_bytes: [u8; 8] = data[version_id_start..version_id_start + 8]
            .try_into()
            .unwrap();
        assert_eq!(
            u64::from_le_bytes(version_id_bytes),
            mint_owner.asset_class_version_id,
            "ASSET_CLASS_VERSION_ID_OFFSET no longer points at asset_class_version_id"
        );
    }
}
