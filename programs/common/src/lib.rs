use crate::state::{AssetClassVersion, Roles};
use anchor_lang::prelude::*;
use std::cell::Ref;

pub mod bitmask;
pub mod functionalities;
pub mod pda_seeds;
pub mod pda_utils;
pub mod program_ids;
pub mod roles;
pub mod state;

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
    #[msg("Could not read the mint owner account data")]
    InvalidMintOwnerData,
    #[msg("The asset class version is not finalized")]
    AssetClassVersionNotFinalized,
    #[msg("Role is past the mask capacity")]
    RoleOutOfBounds,
    #[msg("Signer does not hold the required role")]
    MissingRole,
}

/// Checks whether a `deactivate_pda` (seeds: `["deactivate", mint]`, owned by
/// `deactivate`) exists for a given mint, indicating the mint has been deactivated.
///
/// The account is passed as `&AccountInfo` rather than `Account<T>` so callers are not
/// required to import `deactivate` as a dependency. The `seeds::program` constraint
/// in every caller's account struct already guarantees the address is correct.
///
/// Returns `Ok(())` if the account does not exist (empty data).
/// Returns `Err(CommonError::Deactivated)` if the account has been created.
pub fn require_active(deactivate_pda: &AccountInfo) -> Result<()> {
    require!(deactivate_pda.data_is_empty(), CommonError::Deactivated);
    Ok(())
}

/// Checks whether a Token-2022 mint is paused via the `PausableConfig` extension.
///
/// Parses the TLV extension data of the mint account using `StateWithExtensions`
/// to locate `PausableConfig` and reads its `paused` flag.
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
