use anchor_lang::prelude::*;
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, require_role, roles,
};

use crate::events::AccountAddedToControlList;
use crate::state::ControlListStatus;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};

pub fn add_to_control_list(ctx: Context<AddToControlList>) -> Result<()> {
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_CONTROL_LIST,
    )?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ──────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::TRANSFER_CONTROL_ADD_TO_CONTROL_LIST,
    )?;

    // ── Record canonical bump in the control-list marker PDA ─────────────────────
    ctx.accounts.control_list_pda.bump = ctx.bumps.control_list_pda;

    emit_cpi!(AccountAddedToControlList {
        mint: ctx.accounts.mint.key(),
        account: ctx.accounts.account.key(),
        operator: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct AddToControlList<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, Roles>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: Read-only; validated by require_not_paused (checks the Pausable extension).
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Address used as a seed for control_list_pda; not otherwise validated here.
    pub account: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = authority,
        space = ControlListStatus::DISCRIMINATOR.len() + ControlListStatus::INIT_SPACE,
        seeds = [pda_seeds::CONTROL_LIST, mint.key().as_ref(), account.key().as_ref()],
        bump,
    )]
    pub control_list_pda: Account<'info, ControlListStatus>,

    #[account(
        seeds = [
            pda_seeds::ASSET_CLASS_VERSION,
            &asset_configuration_pda.asset_class_config_id.to_le_bytes(),
            &asset_configuration_pda.asset_class_version_id.to_le_bytes()
        ],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    pub system_program: Program<'info, System>,
}
