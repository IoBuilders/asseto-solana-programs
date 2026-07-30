use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use crate::state::TransferControlMode;
use instructions::*;
pub use state::TransferMode;

declare_id!("3h92PdZJB7TuCzp6iPDtrJm2k8V7fn5ETYNwCYiYy9Eo");

/// Checks whether a `whitelist_pda` exists, indicating the account has been
/// whitelisted for this mint.
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
/// Returns `Ok(())` if the all the PDAs comply with the transfer control mode.
/// Returns `Err(TransferControlError::NotWhitelisted)` if any PDA does not comply.
pub fn verify_transfer_control_mode<'info>(
    transfer_control_mode_pda: &'info AccountInfo<'info>,
    whitelist_pdas: &[&AccountInfo],
) -> Result<()> {
    if transfer_control_mode_pda.data_is_empty() {
        return Ok(());
    }

    let transfer_control_mode =
        Account::<TransferControlMode>::try_from(transfer_control_mode_pda)?;

    if transfer_control_mode.mode == TransferMode::Whitelist {
        for whitelist_pda in whitelist_pdas {
            verify_whitelist(whitelist_pda)?;
        }
    }

    Ok(())
}

#[program]
pub mod transfer_control {
    use super::*;

    pub fn initialize(ctx: Context<SetMode>, mode: TransferMode) -> Result<()> {
        initialize::initialize(ctx, mode)
    }

    pub fn add_to_whitelist(ctx: Context<AddToWhitelist>) -> Result<()> {
        add_to_whitelist::add_to_whitelist(ctx)
    }

    pub fn remove_from_whitelist(ctx: Context<RemoveFromWhitelist>) -> Result<()> {
        remove_from_whitelist::remove_from_whitelist(ctx)
    }
}
