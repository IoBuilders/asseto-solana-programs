use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use crate::state::TransferControlMode;
use instructions::*;
pub use state::TransferMode;

declare_id!("3h92PdZJB7TuCzp6iPDtrJm2k8V7fn5ETYNwCYiYy9Eo");

/// Checks whether a `whitelist_pda` (seeds: `["whitelist", mint, account]`) exists,
/// indicating the account has been whitelisted for this mint.
///
/// Returns `Ok(())` if the PDA exists (account is whitelisted).
/// Returns `Err(TransferControlError::NotWhitelisted)` if the PDA is absent.
pub fn verify_whitelist(whitelist_pda: &AccountInfo) -> Result<()> {
    require!(
        !whitelist_pda.data_is_empty(),
        errors::TransferControlError::NotWhitelisted
    );
    Ok(())
}

/// Checks that every `whitelist_pda` satisfies the active transfer control mode.
///
/// `transfer_control_mode_pda` and each `whitelist_pda` are raw, unchecked PDAs —
/// their address is verified by the caller's `seeds`/`bump` constraints, but their
/// contents are not deserialized by Anchor. An empty account means "does not exist"
/// (no mode set / not whitelisted); a non-empty account is Borsh-deserialized here.
pub fn verify_transfer_control_mode(
    transfer_control_mode_pda: &AccountInfo,
    whitelist_pdas: &[&AccountInfo],
) -> Result<()> {
    if transfer_control_mode_pda.data_is_empty() {
        return Ok(());
    }

    let transfer_control_mode = {
        let data = transfer_control_mode_pda.try_borrow_data()?;
        TransferControlMode::try_deserialize(&mut data.as_ref())?
    };

    if transfer_control_mode.mode == TransferMode::Whitelist {
        for whitelist_pda in whitelist_pdas {
            require!(
                !whitelist_pda.data_is_empty(),
                errors::TransferControlError::NotWhitelisted
            );
        }
    }

    Ok(())
}

#[program]
pub mod transfer_control {
    use super::*;

    /// Initializes the active transfer control modes for a mint.
    ///
    /// The full active mode list is replaced on every call.
    /// - Non-empty vec — creates or updates the PDA with the given modes.
    /// - Empty vec     — closes the PDA if present (returns rent to authority); no controls.
    ///
    /// Management instruction — only an authority with role `ROLE_CONTROL_LIST` may call this.
    /// The mint must not be paused or deactivated.
    pub fn initialize(ctx: Context<SetMode>, mode: TransferMode) -> Result<()> {
        initialize::initialize(ctx, mode)
    }

    /// Adds a token account to the whitelist for a mint by creating a marker PDA.
    ///
    /// Creates the `whitelist_pda` (seeds: `["whitelist", mint, account]`) if it does not
    /// exist yet. If it already exists the instruction is a no-op.
    ///
    /// Management instruction — only an authority with role `ROLE_CONTROL_LIST` may call this.
    /// The mint must not be paused or deactivated.
    pub fn add_to_whitelist(ctx: Context<AddToWhitelist>) -> Result<()> {
        add_to_whitelist::add_to_whitelist(ctx)
    }

    /// Removes a token account from the whitelist for a mint by closing the marker PDA.
    ///
    /// Closes the `whitelist_pda` (seeds: `["whitelist", mint, account]`) and returns its
    /// rent lamports to the authority. If the PDA does not exist the instruction is a no-op.
    ///
    /// Management instruction — only an authority with role `ROLE_CONTROL_LIST` may call this.
    /// The mint must not be paused or deactivated.
    pub fn remove_from_whitelist(ctx: Context<RemoveFromWhitelist>) -> Result<()> {
        remove_from_whitelist::remove_from_whitelist(ctx)
    }
}
