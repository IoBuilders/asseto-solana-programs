use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
pub use state::TransferMode;

declare_id!("BTLbhoZDCguRqmwhXvQej7pmAqV2TXY3iGdwMPsMBBMw");

/// Checks whether a `whitelist_pda` (seeds: `["whitelist", mint, account]`) exists,
/// indicating the account has been whitelisted for this mint.
///
/// Returns `Ok(())` if the PDA exists (account is whitelisted).
/// Returns `Err(CmtatTransferControlError::NotWhitelisted)` if the PDA is absent.
pub fn verify_whitelist(whitelist_pda: &AccountInfo) -> Result<()> {
    require!(
        !whitelist_pda.data_is_empty(),
        crate::errors::CmtatTransferControlError::NotWhitelisted
    );
    Ok(())
}

/// Returns the active transfer control mode for the given mint.
///
/// - `None`                       — PDA absent; no controls active.
/// - `Some(TransferMode::Clearing)` — deployer must co-sign every transfer.
/// - `Some(TransferMode::Whitelist)` — source and destination must be whitelisted.
///
/// Deserializes the PDA only once, eliminating the double-read that two separate
/// boolean helpers would require.
pub fn get_transfer_mode(transfer_control_mode_pda: &AccountInfo) -> Result<Option<TransferMode>> {
    use crate::state::TransferControlMode;

    if transfer_control_mode_pda.data_is_empty() {
        return Ok(None);
    }
    let data = transfer_control_mode_pda.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let mode_pda = TransferControlMode::try_deserialize(&mut slice)
        .map_err(|_| error!(anchor_lang::error::ErrorCode::AccountDidNotDeserialize))?;
    Ok(Some(mode_pda.mode))
}

#[program]
pub mod cmtat_transfer_control {
    use super::*;

    /// Sets, updates, or removes the Transfer Control Mode for a mint.
    ///
    /// - `Some(TransferMode::Clearing)`  — creates or overwrites the PDA; deployer must co-sign transfers.
    /// - `Some(TransferMode::Whitelist)` — creates or overwrites the PDA; source/dest must be whitelisted.
    /// - `None`                          — closes the PDA if present (returns rent to deployer); no controls.
    ///
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    /// The mint must not be paused or deactivated.
    pub fn set_mode(ctx: Context<SetMode>, mode: Option<TransferMode>) -> Result<()> {
        instructions::set_mode::set_mode(ctx, mode)
    }

    /// Adds a token account to the whitelist for a mint by creating a marker PDA.
    ///
    /// Creates the `whitelist_pda` (seeds: `["whitelist", mint, account]`) if it does not
    /// exist yet. If it already exists the instruction is a no-op.
    ///
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    /// The mint must not be paused or deactivated.
    pub fn add_to_whitelist(ctx: Context<AddToWhitelist>) -> Result<()> {
        instructions::add_to_whitelist::add_to_whitelist(ctx)
    }

    /// Removes a token account from the whitelist for a mint by closing the marker PDA.
    ///
    /// Closes the `whitelist_pda` (seeds: `["whitelist", mint, account]`) and returns its
    /// rent lamports to the deployer. If the PDA does not exist the instruction is a no-op.
    ///
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    /// The mint must not be paused or deactivated.
    pub fn remove_from_whitelist(ctx: Context<RemoveFromWhitelist>) -> Result<()> {
        instructions::remove_from_whitelist::remove_from_whitelist(ctx)
    }

    // Just to make TransferControlMode part of the IDL
    pub fn __idl_expose_transfer_control_mode(
        _ctx: Context<__TransferControlModeIDL>,
    ) -> Result<()> {
        Ok(())
    }
}
