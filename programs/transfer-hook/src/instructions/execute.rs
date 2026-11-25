use anchor_lang::prelude::*;
use common::program_ids::{HOLD_PROGRAM_ID, OPERATIONS_PROGRAM_ID};
use common::{
    freeze_status, pda_seeds, pda_utils, require_locked_balance_covered,
    verify_transfer_control_mode, CommonError,
};
use spl_token_2022_interface::extension::{
    transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions,
};
use spl_token_2022_interface::state::Account as TokenAccountState;

use crate::errors::TransferHookError;
use crate::state::MintCompliance;

pub fn execute<'info>(ctx: Context<'info, Execute<'info>>, _amount: u64) -> Result<()> {
    require_transferring(&ctx.accounts.source_token.to_account_info())?;

    // SECURITY: only operations::controller_transfer can present the
    // permanent_delegate PDA as the transfer authority (Token-2022 verifies the
    // authority signed, and only operations can invoke_signed those seeds), so
    // this bypass of the compliance suite is unreachable by a normal holder.
    if pda_utils::is_caller_pda(
        ctx.accounts.owner.key,
        &pda_seeds::permanent_delegate_seeds(ctx.accounts.mint.key),
        &OPERATIONS_PROGRAM_ID,
    ) {
        return Ok(());
    }

    let (deactivated, transfer_mode, transfer_hook_execute_enabled) = {
        let mint_compliance = ctx.accounts.mint_compliance_pda.load()?;
        (
            mint_compliance.deactivated != 0,
            mint_compliance.transfer_mode,
            mint_compliance.transfer_hook_execute_enabled != 0,
        )
    };
    require!(!deactivated, CommonError::Deactivated);

    verify_transfer_control_mode(
        transfer_mode,
        &[
            &ctx.accounts.source_account_compliance_pda,
            &ctx.accounts.destination_account_compliance_pda,
        ],
    )?;

    let freeze_status = freeze_status(&ctx.accounts.source_account_compliance_pda)?;
    require!(!freeze_status.fully_frozen, CommonError::AccountFrozen);

    // The hook runs post-debit, so this asserts balance_post >= frozen + held.
    let total_locked = freeze_status
        .frozen_balance
        .checked_add(common::held_amount(&ctx.accounts.source_hold_position_pda)?)
        .ok_or(error!(CommonError::InsufficientUnfrozenBalance))?;
    require_locked_balance_covered(&ctx.accounts.source_token, total_locked)?;

    require!(
        transfer_hook_execute_enabled,
        CommonError::FunctionalityNotSupportedError
    );

    Ok(())
}

fn require_transferring(source_token: &AccountInfo) -> Result<()> {
    let data = source_token.try_borrow_data()?;
    let state = StateWithExtensions::<TokenAccountState>::unpack(&data)
        .map_err(|_| error!(TransferHookError::NotTransferring))?;
    let extension = state
        .get_extension::<TransferHookAccount>()
        .map_err(|_| error!(TransferHookError::NotTransferring))?;
    require!(
        bool::from(extension.transferring),
        TransferHookError::NotTransferring
    );
    Ok(())
}

/// Accounts for `execute`.
///
/// Indices 0–4 are fixed by the SPL Transfer Hook interface. Indices 5+ are the
/// ExtraAccountMetaList entries, in the order declared by
/// `initialize_extra_account_meta_list`. Every compliance PDA is resolved and
/// forwarded by Token-2022 from that list.
#[derive(Accounts)]
pub struct Execute<'info> {
    // Indices 0–4 are the SPL-interface-fixed accounts Token-2022 passes as the
    // transfer's own accounts; the hook only reads them.
    /// CHECK: transfer's source token account; balance read for the frozen-balance check.
    pub source_token: UncheckedAccount<'info>,
    /// CHECK: transfer's mint; used as a seed component.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: transfer's destination token account; used as a seed component.
    pub destination_token: UncheckedAccount<'info>,
    /// CHECK: transfer authority; compared against the permanent-delegate PDA for the bypass.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the mint's ExtraAccountMetaList; canonicity enforced by Token-2022.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    #[account(
        seeds = [pda_seeds::MINT_COMPLIANCE, mint.key().as_ref()],
        bump = mint_compliance_pda.load()?.bump,
    )]
    pub mint_compliance_pda: AccountLoader<'info, MintCompliance>,

    /// CHECK: Source compliance record (index 6); may be empty (nothing recorded). Owner
    /// and discriminator checked by the common readers.
    #[account(
        seeds = [pda_seeds::ACCOUNT_COMPLIANCE, mint.key().as_ref(), source_token.key().as_ref()],
        bump,
    )]
    pub source_account_compliance_pda: UncheckedAccount<'info>,

    /// CHECK: Destination compliance record (index 7); may be empty (nothing recorded).
    /// Owner and discriminator checked by common::in_control_list.
    #[account(
        seeds = [pda_seeds::ACCOUNT_COMPLIANCE, mint.key().as_ref(), destination_token.key().as_ref()],
        bump,
    )]
    pub destination_account_compliance_pda: UncheckedAccount<'info>,

    /// CHECK: hold program (index 8); resolves source_hold_position_pda in the metalist.
    #[account(address = HOLD_PROGRAM_ID)]
    pub hold_program: UncheckedAccount<'info>,

    /// CHECK: Source held-balance accumulator (index 9); may be empty (no hold ever created).
    #[account(
        seeds = [pda_seeds::HOLD_POSITION, mint.key().as_ref(), source_token.key().as_ref()],
        seeds::program = HOLD_PROGRAM_ID,
        bump,
    )]
    pub source_hold_position_pda: UncheckedAccount<'info>,
}
