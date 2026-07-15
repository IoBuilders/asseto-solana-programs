use crate::state::{AssetClassVersion, MintOwner};
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
    #[msg("The deployer signature is required but was not provided or does not match")]
    UnauthorizedDeployer,
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
    #[msg("Signer does not hold the required role")]
    MissingRole,
}

/// Verifies that `deployer` matches the pubkey stored in a `mint_owner_pda`
/// account created by `deploy`.
///
/// Deserializes the account using Borsh (`MintOwner::deserialize`) after skipping
/// the 8-byte Anchor discriminator. Full `AccountDeserialize` (which also checks the
/// discriminator) is not available here because `MintOwner` cannot use the `#[account]`
/// macro in a library crate (that macro requires `declare_id!`). The discriminator check
/// is redundant anyway: the `seeds::program` constraint in every caller's account struct
/// already guarantees this is the correct account at the correct address.
///
/// The account is passed as `&AccountInfo` rather than `Account<MintOwner>` because
/// Anchor's `Account<T>` wrapper enforces ownership by the *current* program, but
/// `mint_owner_pda` is owned by `deploy`.
pub fn verify_deployer(mint_owner_pda: &AccountInfo, deployer: &Pubkey) -> Result<()> {
    use state::MintOwner;

    let data = mint_owner_pda.try_borrow_data()?;
    require!(
        data.len() >= 8 + MintOwner::INIT_SPACE,
        CommonError::UnauthorizedDeployer
    );

    // Skip 8-byte discriminator, then Borsh-deserialize the remaining fields.
    let mint_owner = MintOwner::deserialize(&mut &data[8..])
        .map_err(|_| error!(CommonError::UnauthorizedDeployer))?;

    require!(
        mint_owner.deployer == *deployer,
        CommonError::UnauthorizedDeployer
    );
    Ok(())
}

pub fn verify_deployer_account(mint_owner_pda: &MintOwner, deployer: &Pubkey) -> Result<()> {
    require!(
        mint_owner_pda.deployer == *deployer,
        CommonError::UnauthorizedDeployer
    );
    Ok(())
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

/// Checks whether `role` is granted in an access-control `Roles` account's mask.
///
/// `roles_pda` is the `Roles` PDA (seeds `[mint, account]`, owned by the
/// access-control program). Returns `Ok(())` if the bit for `role` is set;
/// `Err(CommonError::MissingRole)` otherwise, including when the PDA has never
/// been created (empty / not owned by access-control).
///
/// Like `require_active`/`require_functionality`, `roles_pda` is passed as
/// `&AccountInfo` rather than access-control's typed `Roles`, because
/// access-control already depends on `common` (the reverse would be circular).
/// The mask is read through a short-lived borrow that is released before this
/// returns, so a caller may safely `load_mut` the same account afterwards (an
/// admin granting/revoking a role on themselves). Both `require_functionality`
/// and `require_role` reduce to `bitmask::is_set`; they differ only in where the
/// mask comes from (a loaded struct vs. raw account bytes) and how they treat
/// an out-of-range/absent bit, so there is no larger shared core to factor out.
pub fn require_role(roles_pda: &AccountInfo, role: u16) -> Result<()> {
    require!(has_role(roles_pda, role)?, CommonError::MissingRole);
    Ok(())
}

fn has_role(roles_pda: &AccountInfo, role: u16) -> Result<bool> {
    let data = roles_pda.try_borrow_data()?;
    // A never-created (empty) or malformed (too-short) PDA has no roles; this
    // guard also keeps the slice below in bounds. No owner check is needed —
    // the seeds constraint pins the address and only access-control can put data
    // at its own PDA.
    if data.len() <= roles::ROLES_MASK_OFFSET {
        return Ok(false);
    }

    Ok(bitmask::is_set(&data[roles::ROLES_MASK_OFFSET..], role).unwrap_or(false))
}
