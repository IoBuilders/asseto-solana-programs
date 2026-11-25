use crate::state::{AssetClassVersion, Roles};
use anchor_lang::prelude::*;
use std::cell::Ref;

pub mod bitmask;
pub mod functionalities;
pub mod hook_accounts;
pub mod merkle;
pub mod pda_seeds;
pub mod pda_utils;
pub mod program_ids;
pub mod roles;
pub mod state;

pub use hook_accounts::{HookAccounts, HOOK_FORWARDED_ACCOUNT_COUNT};
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
    #[msg("Could not read the hold position account data")]
    InvalidHoldPositionData,
    #[msg("The asset class version is not finalized")]
    AssetClassVersionNotFinalized,
    #[msg("Role is past the mask capacity")]
    RoleOutOfBounds,
    #[msg("Signer does not hold the required role")]
    MissingRole,
    #[msg("Amount exceeds the balance left spendable by the account's hold liens")]
    InsufficientSpendableBalance,
    #[msg("Provided hold_position_pda does not match the derived PDA for this account")]
    HoldPositionPdaMismatch,
    #[msg("Merkle proof does not prove the given (account, balance) against the snapshot root")]
    InvalidMerkleProof,
    #[msg("The account has been frozen")]
    AccountFrozen,
    #[msg("Transfer amount exceeds available (unfrozen) balance")]
    InsufficientUnfrozenBalance,
    #[msg("Provided account_compliance_pda does not match the derived PDA for this account")]
    AccountCompliancePdaMismatch,
    #[msg("The account is not whitelisted")]
    NotWhitelisted,
    #[msg("The account is blacklisted")]
    Blacklisted,
}

pub fn require_active(mint_compliance: Ref<state::MintCompliance>) -> Result<()> {
    require!(!mint_compliance.is_deactivated(), CommonError::Deactivated);
    Ok(())
}

/// Checks whether a Token-2022 mint is paused via the `PausableConfig` extension.
///
/// Returns `Ok(())` if the mint is **not** paused.
/// Returns `Err(CommonError::MintPaused)` if the mint is paused.
/// Returns Err if the mint has no Pausable extension — something that should never happen for a correctly deployed mint.
pub fn require_not_paused(mint_account: &AccountInfo) -> Result<()> {
    use spl_token_2022_interface::extension::pausable::PausableConfig;
    use spl_token_2022_interface::extension::{BaseStateWithExtensions, StateWithExtensions};
    use spl_token_2022_interface::state::Mint;

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
    let enabled = is_functionality_enabled(asset_class_version, functionality)?;
    require!(enabled, CommonError::FunctionalityNotSupportedError);
    Ok(())
}

pub fn is_functionality_enabled(
    asset_class_version: Ref<AssetClassVersion>,
    functionality: u16,
) -> Result<bool> {
    require!(
        asset_class_version.state == state::ASSET_CLASS_VERSION_STATE_FINALIZED,
        CommonError::AssetClassVersionNotFinalized
    );

    let enabled = bitmask::is_set(&asset_class_version.mask, functionality)
        .map_err(|_| error!(CommonError::FunctionalityOutOfBounds))?;

    Ok(enabled)
}

pub fn require_role(roles_pda: Ref<Roles>, role: u16) -> Result<()> {
    let enabled =
        bitmask::is_set(&roles_pda.mask, role).map_err(|_| error!(CommonError::RoleOutOfBounds))?;

    require!(enabled, CommonError::MissingRole);

    Ok(())
}

/// For an `account_compliance_pda` arriving through `remaining_accounts`, where no
/// `seeds` constraint applies: without it a caller could have one account's record
/// read in place of another's.
pub fn verify_account_compliance_pda(
    account_compliance_pda: &AccountInfo,
    token_account: &Pubkey,
    mint: &Pubkey,
) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(
        &pda_seeds::account_compliance_seeds(mint, token_account),
        &program_ids::TRANSFER_HOOK_PROGRAM_ID,
    );
    require_keys_eq!(
        account_compliance_pda.key(),
        expected,
        CommonError::AccountCompliancePdaMismatch
    );
    Ok(())
}

pub fn require_balance_proof(
    proof: &[[u8; 32]],
    root: [u8; 32],
    account: Pubkey,
    balance: u64,
) -> Result<()> {
    require!(
        merkle::verify_balance_proof(proof, root, account, balance),
        CommonError::InvalidMerkleProof
    );
    Ok(())
}

#[derive(Default, Clone, Copy)]
pub struct FreezeStatus {
    pub fully_frozen: bool,
    pub frozen_balance: u64,
}

/// An absent `AccountCompliance` means nothing was ever recorded for the account.
fn load_account_compliance<'info>(
    account_compliance_pda: &'info AccountInfo<'info>,
) -> Result<Option<state::AccountCompliance>> {
    if account_compliance_pda.data_is_empty() {
        return Ok(None);
    }
    let loader = AccountLoader::<state::AccountCompliance>::try_from(account_compliance_pda)?;
    let record = *loader.load()?;
    Ok(Some(record))
}

pub fn freeze_status<'info>(
    account_compliance_pda: &'info AccountInfo<'info>,
) -> Result<FreezeStatus> {
    Ok(load_account_compliance(account_compliance_pda)?
        .map(|record| FreezeStatus {
            fully_frozen: record.is_fully_frozen(),
            frozen_balance: record.frozen_balance,
        })
        .unwrap_or_default())
}

pub fn in_control_list<'info>(account_compliance_pda: &'info AccountInfo<'info>) -> Result<bool> {
    Ok(load_account_compliance(account_compliance_pda)?
        .is_some_and(|record| record.is_in_control_list()))
}

/// `transfer_mode` is `MintCompliance.transfer_mode`; every account in
/// `account_compliance_pdas` must satisfy it (no mode set = no restriction).
pub fn verify_transfer_control_mode<'info>(
    transfer_mode: u8,
    account_compliance_pdas: &[&'info AccountInfo<'info>],
) -> Result<()> {
    match transfer_mode {
        state::TRANSFER_MODE_WHITELIST => {
            for pda in account_compliance_pdas {
                require!(in_control_list(pda)?, CommonError::NotWhitelisted);
            }
        }
        state::TRANSFER_MODE_BLACKLIST => {
            for pda in account_compliance_pdas {
                require!(!in_control_list(pda)?, CommonError::Blacklisted);
            }
        }
        _ => {}
    }
    Ok(())
}

/// `total_locked` is the caller's sum of every lien on the account (partial freeze +
/// holds). Post-debit callers (the hook) pass it as-is; see docs/common.md.
pub fn require_locked_balance_covered(
    token_account: &AccountInfo,
    total_locked: u64,
) -> Result<()> {
    use spl_token_2022_interface::extension::StateWithExtensions;
    use spl_token_2022_interface::state::Account as TokenAccountState;

    let token_data = token_account.try_borrow_data()?;
    let token_state = StateWithExtensions::<TokenAccountState>::unpack(&token_data)
        .map_err(|_| error!(CommonError::InsufficientUnfrozenBalance))?;
    require!(
        token_state.base.amount >= total_locked,
        CommonError::InsufficientUnfrozenBalance
    );
    Ok(())
}

pub fn held_amount<'info>(hold_position_pda: &'info AccountInfo<'info>) -> Result<u64> {
    if hold_position_pda.data_is_empty() {
        return Ok(0);
    }
    Ok(Account::<state::HoldPosition>::try_from(hold_position_pda)?.held_amount)
}

/// Pre-debit check for the paths Token-2022 runs no transfer hook on: asserts
/// `balance >= held + amount`, so taking `amount` out of the account still leaves
/// every hold executable. Deliberately ignores the partial-freeze balance — see
/// docs/operations.md. See docs/common.md.
pub fn require_hold_covered<'info>(
    token_account: &AccountInfo,
    hold_position_pda: &'info AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    use spl_token_2022_interface::extension::StateWithExtensions;
    use spl_token_2022_interface::state::Account as TokenAccountState;

    let token_data = token_account.try_borrow_data()?;
    let token_state = StateWithExtensions::<TokenAccountState>::unpack(&token_data)
        .map_err(|_| error!(CommonError::InsufficientSpendableBalance))?;

    let required = held_amount(hold_position_pda)?
        .checked_add(amount)
        .ok_or(CommonError::InsufficientSpendableBalance)?;

    require!(
        token_state.base.amount >= required,
        CommonError::InsufficientSpendableBalance
    );

    Ok(())
}

/// [`require_hold_covered`] for a `hold_position_pda` arriving through
/// `remaining_accounts`, where no `seeds` constraint can validate its address: it is
/// derived here and compared, so a caller cannot substitute an empty account to
/// fake a zero lien.
pub fn require_hold_covered_unverified_pda<'info>(
    token_account: &'info AccountInfo<'info>,
    hold_position_pda: &'info AccountInfo<'info>,
    mint: &Pubkey,
    amount: u64,
) -> Result<()> {
    let (expected_hold_position_pda, _) = Pubkey::find_program_address(
        &pda_seeds::hold_position_seeds(mint, &token_account.key()),
        &program_ids::HOLD_PROGRAM_ID,
    );
    require_keys_eq!(
        hold_position_pda.key(),
        expected_hold_position_pda,
        CommonError::HoldPositionPdaMismatch
    );

    require_hold_covered(token_account, hold_position_pda, amount)
}
