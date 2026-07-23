use crate::CommonError::InvalidAssetConfigurationData;
use anchor_lang::prelude::*;

/// Byte offset of `AssetConfiguration::asset_class_config_id` within the account data.
/// Derived from the fields that precede it in declaration order
pub const ASSET_CLASS_CONFIG_ID_OFFSET: u8 = AssetConfiguration::DISCRIMINATOR.len() as u8;

/// Byte offset of `AssetConfiguration::asset_class_version_id` within the account data —
/// immediately after `asset_class_config_id: u64`.
pub const ASSET_CLASS_VERSION_ID_OFFSET: u8 = ASSET_CLASS_CONFIG_ID_OFFSET + size_of::<u64>() as u8;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct AssetConfiguration {
    pub asset_class_config_id: u64,
    pub asset_class_version_id: u64,
    pub bump: u8,
}

impl Discriminator for AssetConfiguration {
    /// The 8-byte Anchor account discriminator for `deploy::state::AssetConfiguration`
    /// Computed here since this crate has no `declare_id!`/`#[account]` to derive it from
    /// Defined in `common` so all downstream programs can deserialize it
    const DISCRIMINATOR: &'static [u8] = &[15, 79, 132, 40, 8, 129, 114, 149];
}

impl Owner for AssetConfiguration {
    fn owner() -> Pubkey {
        crate::program_ids::DEPLOY_PROGRAM_ID
    }
}

impl AccountDeserialize for AssetConfiguration {
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
        AssetConfiguration::deserialize(&mut &buf[Self::DISCRIMINATOR.len()..])
            .map_err(|_| error!(InvalidAssetConfigurationData))
    }
}

// No-op: We can't write to another program's account.
impl AccountSerialize for AssetConfiguration {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards `ASSET_CLASS_CONFIG_ID_OFFSET` / `ASSET_CLASS_VERSION_ID_OFFSET`
    /// against `AssetConfiguration` ever changing field order/types
    #[test]
    fn asset_configuration_offsets_match_actual_layout() {
        let asset_configuration = AssetConfiguration {
            asset_class_config_id: 0x1122_3344_5566_7788,
            asset_class_version_id: 0x99AA_BBCC_DDEE_FF00,
            bump: 7,
        };

        let mut data = AssetConfiguration::DISCRIMINATOR.to_vec();
        asset_configuration.serialize(&mut data).unwrap();

        let config_id_start = ASSET_CLASS_CONFIG_ID_OFFSET as usize;
        let config_id_bytes: [u8; 8] = data[config_id_start..config_id_start + 8]
            .try_into()
            .unwrap();
        assert_eq!(
            u64::from_le_bytes(config_id_bytes),
            asset_configuration.asset_class_config_id,
            "ASSET_CLASS_CONFIG_ID_OFFSET no longer points at asset_class_config_id"
        );

        let version_id_start = ASSET_CLASS_VERSION_ID_OFFSET as usize;
        let version_id_bytes: [u8; 8] = data[version_id_start..version_id_start + 8]
            .try_into()
            .unwrap();
        assert_eq!(
            u64::from_le_bytes(version_id_bytes),
            asset_configuration.asset_class_version_id,
            "ASSET_CLASS_VERSION_ID_OFFSET no longer points at asset_class_version_id"
        );
    }
}
