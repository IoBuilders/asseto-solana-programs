use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

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

/// Returns the active transfer control modes for the given mint.
///
/// Returns an empty vec when the PDA is absent (no controls active).
/// Otherwise deserializes the PDA and returns the full list of active modes.
pub fn get_transfer_modes(transfer_control_mode_pda: &AccountInfo) -> Result<Vec<TransferMode>> {
    use crate::state::TransferControlMode;

    if transfer_control_mode_pda.data_is_empty() {
        return Ok(vec![]);
    }
    let data = transfer_control_mode_pda.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let mode_pda = TransferControlMode::try_deserialize(&mut slice)
        .map_err(|_| error!(anchor_lang::error::ErrorCode::AccountDidNotDeserialize))?;
    Ok(mode_pda.modes)
}

#[program]
pub mod transfer_control {
    use super::*;

    /// Sets, updates, or removes the active transfer control modes for a mint.
    ///
    /// The full active mode list is replaced on every call.
    /// - Non-empty vec — creates or updates the PDA with the given modes.
    /// - Empty vec     — closes the PDA if present (returns rent to deployer); no controls.
    ///
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    /// The mint must not be paused or deactivated.
    pub fn set_modes(ctx: Context<SetMode>, modes: Vec<TransferMode>) -> Result<()> {
        set_modes::set_modes(ctx, modes)
    }

    /// Adds a token account to the whitelist for a mint by creating a marker PDA.
    ///
    /// Creates the `whitelist_pda` (seeds: `["whitelist", mint, account]`) if it does not
    /// exist yet. If it already exists the instruction is a no-op.
    ///
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    /// The mint must not be paused or deactivated.
    pub fn add_to_whitelist(ctx: Context<AddToWhitelist>) -> Result<()> {
        add_to_whitelist::add_to_whitelist(ctx)
    }

    /// Removes a token account from the whitelist for a mint by closing the marker PDA.
    ///
    /// Closes the `whitelist_pda` (seeds: `["whitelist", mint, account]`) and returns its
    /// rent lamports to the deployer. If the PDA does not exist the instruction is a no-op.
    ///
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    /// The mint must not be paused or deactivated.
    pub fn remove_from_whitelist(ctx: Context<RemoveFromWhitelist>) -> Result<()> {
        remove_from_whitelist::remove_from_whitelist(ctx)
    }

    // Just to make TransferControlMode part of the IDL
    pub fn __idl_expose_transfer_control_mode(
        _ctx: Context<__TransferControlModeIDL>,
    ) -> Result<()> {
        Ok(())
    }
}
