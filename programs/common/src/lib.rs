use crate::state::{AssetClassVersion, Roles};
use anchor_lang::prelude::*;
use std::cell::Ref;

pub mod bitmask;
pub mod functionalities;
pub mod merkle;
pub mod pda_seeds;
pub mod pda_utils;
pub mod program_ids;
pub mod roles;
pub mod state;

pub use merkle::{leaf_hash, verify_balance_proof, LeafData};

#[cfg(test)]
pub(crate) mod test_support;

#[error_code]
pub enum CommonError {
    #[msg("The mint is paused")]
    MintPaused,
    #[msg("The mint has been deactivated")]
    Deactivated,
    #[msg("Functionality is past the mask capacity")]
    FunctionalityOutOfBounds,
    #[msg("The asset class version does not support this functionality")]
    FunctionalityNotSupportedError,
    #[msg("Could not read the asset configuration account data")]
    InvalidAssetConfigurationData,
    #[msg("The asset class version is not finalized")]
    AssetClassVersionNotFinalized,
    #[msg("Role is past the mask capacity")]
    RoleOutOfBounds,
    #[msg("Signer does not hold the required role")]
    MissingRole,
    #[msg("A whitelist PDA does not match the one derived for its destination")]
    WhitelistPdaMismatch,
}

/// Checks whether a `deactivate_pda` exists for a given mint.
///
/// Takes `&AccountInfo` rather than `Account<T>` so callers don't need `deactivate`
/// as a dependency — the caller's own `seeds::program` constraint already guarantees
/// the address is correct.
///
/// Returns `Ok(())` if the account does not exist (empty data).
/// Returns `Err(CommonError::Deactivated)` if the account has been created.
pub fn require_active(deactivate_pda: &AccountInfo) -> Result<()> {
    require!(deactivate_pda.data_is_empty(), CommonError::Deactivated);
    Ok(())
}

/// Checks whether a Token-2022 mint is paused via the `PausableConfig` extension.
///
/// Returns `Ok(())` if the mint is **not** paused.
/// Returns `Err(CommonError::MintPaused)` if the mint is paused.
/// Returns Err if the mint has no Pausable extension — something that should never happen for a correctly deployed mint.
pub fn require_not_paused(mint_account: &AccountInfo) -> Result<()> {
    use spl_token_2022::extension::pausable::PausableConfig;
    use spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};
    use spl_token_2022::state::Mint;

    let mint_data = mint_account.try_borrow_data()?;
    let mint_state = StateWithExtensions::<Mint>::unpack(&mint_data)?;

    let pausable_config = mint_state.get_extension::<PausableConfig>()?;

    require!(!bool::from(pausable_config.paused), CommonError::MintPaused);

    Ok(())
}

/// Checks whether `functionality` (one of the constants above) is enabled in an
/// `AssetClassVersion` account's mask.
///
/// Returns `Ok(())` if the bit for `functionality` is set.
/// Returns `Err(CommonError::FunctionalityNotSupportedError)` if it isn't
pub fn require_functionality(
    asset_class_version: Ref<AssetClassVersion>,
    functionality: u16,
) -> Result<()> {
    require!(
        asset_class_version.state == state::ASSET_CLASS_VERSION_STATE_FINALIZED,
        CommonError::AssetClassVersionNotFinalized
    );

    let enabled = bitmask::is_set(&asset_class_version.mask, functionality)
        .map_err(|_| error!(CommonError::FunctionalityOutOfBounds))?;

    require!(enabled, CommonError::FunctionalityNotSupportedError);
    Ok(())
}

pub fn require_role(roles_pda: Ref<Roles>, role: u16) -> Result<()> {
    let enabled =
        bitmask::is_set(&roles_pda.mask, role).map_err(|_| error!(CommonError::RoleOutOfBounds))?;

    require!(enabled, CommonError::MissingRole);

    Ok(())
}

/// Validates that a `whitelist_pda` is the canonical PDA owned by `transfer-control`.
///
/// Returns `Ok(())` if the whitelist PDA is correct.
/// Returns `Err(CommonError::WhitelistPdaMismatch)` on a mismatch.
pub fn verify_whitelist_pda(
    whitelist_pda: &AccountInfo,
    destination: &Pubkey,
    mint: &Pubkey,
) -> Result<()> {
    let (expected_whitelist_pda, _) = Pubkey::find_program_address(
        &[pda_seeds::WHITELIST, mint.as_ref(), destination.as_ref()],
        &program_ids::TRANSFER_CONTROL_PROGRAM_ID,
    );
    require_keys_eq!(
        whitelist_pda.key(),
        expected_whitelist_pda,
        CommonError::WhitelistPdaMismatch
    );

    Ok(())
}
