use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use crate::state::TransferControlMode;
use instructions::*;
pub use state::TransferMode;

declare_id!("3h92PdZJB7TuCzp6iPDtrJm2k8V7fn5ETYNwCYiYy9Eo");

/// Checks whether a `control_list_pda` exists, indicating the account is in the
/// control list for this mint.
///
/// Returns `Ok(())` if the PDA exists (account is in the control list).
/// Returns `Err(TransferControlError::NotWhitelisted)` if the PDA is absent.
pub fn verify_control_list_membership(control_list_pda: &AccountInfo) -> Result<()> {
    require!(
        !control_list_pda.data_is_empty(),
        errors::TransferControlError::NotWhitelisted
    );
    Ok(())
}

/// Checks that every `control_list_pda` satisfies the active transfer control mode.
///
/// Returns `Ok(())` if the all the PDAs comply with the transfer control mode.
/// Returns `Err(TransferControlError::NotWhitelisted)` if any PDA does not comply.
pub fn verify_transfer_control_mode<'info>(
    transfer_control_mode_pda: &'info AccountInfo<'info>,
    control_list_pdas: &[&AccountInfo],
) -> Result<()> {
    if transfer_control_mode_pda.data_is_empty() {
        return Ok(());
    }

    let transfer_control_mode =
        Account::<TransferControlMode>::try_from(transfer_control_mode_pda)?;

    if transfer_control_mode.mode == TransferMode::Whitelist {
        for control_list_pda in control_list_pdas {
            verify_control_list_membership(control_list_pda)?;
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

    pub fn add_to_control_list(ctx: Context<AddToControlList>) -> Result<()> {
        add_to_control_list::add_to_control_list(ctx)
    }

    pub fn remove_from_control_list(ctx: Context<RemoveFromControlList>) -> Result<()> {
        remove_from_control_list::remove_from_control_list(ctx)
    }
}
