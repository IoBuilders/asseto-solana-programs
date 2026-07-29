use anchor_lang::prelude::*;
use common::program_ids::{
    DEACTIVATE_PROGRAM_ID, DEPLOY_PROGRAM_ID, FACTORY_PROGRAM_ID, FREEZE_PROGRAM_ID,
    OPERATIONS_PROGRAM_ID, TRANSFER_CONTROL_PROGRAM_ID,
};
use common::state::{AssetClassVersion, AssetConfiguration};
use common::{pda_seeds, pda_utils, require_active, require_functionality};
use freeze::{require_frozen_balance_covered, require_unfrozen_account};
use spl_token_2022::extension::{
    transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions,
};
use spl_token_2022::state::Account as TokenAccountState;
use transfer_control::verify_transfer_control_mode;

use crate::errors::TransferHookError;

pub fn execute(ctx: Context<Execute>, _amount: u64) -> Result<()> {
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

    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    verify_transfer_control_mode(
        &ctx.accounts.transfer_control_mode_pda.to_account_info(),
        &[
            &ctx.accounts.source_whitelist_pda.to_account_info(),
            &ctx.accounts.destination_whitelist_pda.to_account_info(),
        ],
    )?;

    require_unfrozen_account(&ctx.accounts.source_frozen_pda.to_account_info())?;

    // The hook runs post-debit, so this asserts balance_post >= frozen.
    require_frozen_balance_covered(
        &ctx.accounts.source_token.to_account_info(),
        &ctx.accounts.source_frozen_balance_pda.to_account_info(),
    )?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::TRANSFER_HOOK_EXECUTE,
    )?;

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

    /// CHECK: address verified by constraint; resolves asset_configuration_pda in the metalist.
    #[account(address = DEPLOY_PROGRAM_ID)]
    pub deploy_program: UncheckedAccount<'info>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: address verified by constraint; resolves asset_class_version_pda in the metalist.
    #[account(address = FACTORY_PROGRAM_ID)]
    pub factory_program: UncheckedAccount<'info>,

    #[account(
        seeds = [
            pda_seeds::ASSET_CLASS_VERSION,
            &asset_configuration_pda.asset_class_config_id.to_le_bytes(),
            &asset_configuration_pda.asset_class_version_id.to_le_bytes()
        ],
        seeds::program = FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    /// CHECK: deactivate program (index 9); resolves deactivate_pda in the metalist.
    #[account(address = DEACTIVATE_PROGRAM_ID)]
    pub deactivate_program: UncheckedAccount<'info>,

    /// CHECK: Deactivation marker (index 10); seeds verified, emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// CHECK: transfer-control program (index 11); resolves the mode + whitelist PDAs.
    #[account(address = TRANSFER_CONTROL_PROGRAM_ID)]
    pub transfer_control_program: UncheckedAccount<'info>,

    /// CHECK: Transfer-control mode (index 12); may be empty (no mode active).
    #[account(
        seeds = [pda_seeds::TRANSFER_CONTROL_MODE, mint.key().as_ref()],
        seeds::program = TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub transfer_control_mode_pda: UncheckedAccount<'info>,

    /// CHECK: Source whitelist marker (index 13); seeded by the source token account.
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), source_token.key().as_ref()],
        seeds::program = TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub source_whitelist_pda: UncheckedAccount<'info>,

    /// CHECK: Destination whitelist marker (index 14); seeded by the destination token account.
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), destination_token.key().as_ref()],
        seeds::program = TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub destination_whitelist_pda: UncheckedAccount<'info>,

    /// CHECK: freeze program (index 15); resolves the frozen PDAs in the metalist.
    #[account(address = FREEZE_PROGRAM_ID)]
    pub freeze_program: UncheckedAccount<'info>,

    /// CHECK: Source frozen-account marker (index 16); emptiness checked by require_unfrozen_account.
    #[account(
        seeds = [pda_seeds::FROZEN_ACCOUNT, mint.key().as_ref(), source_token.key().as_ref()],
        seeds::program = FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_pda: UncheckedAccount<'info>,

    /// CHECK: Source partial-freeze balance (index 17); may be empty (no partial freeze).
    #[account(
        seeds = [pda_seeds::FROZEN_BALANCE, mint.key().as_ref(), source_token.key().as_ref()],
        seeds::program = FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_balance_pda: UncheckedAccount<'info>,
}
