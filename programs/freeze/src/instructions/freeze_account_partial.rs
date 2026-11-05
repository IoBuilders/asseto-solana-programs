use crate::events::AccountPartiallyFrozen;
use anchor_lang::prelude::*;
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, require_role, roles,
};

use crate::errors::ErrorCode;
use crate::state::FreezeState;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};

pub fn freeze_account_partial(ctx: Context<FreezeAccountPartial>, balance: u64) -> Result<()> {
    // ── Verify caller holds the freeze-manager role ───────────────────────────
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_FREEZE_MANAGER,
    )?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ──────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::FREEZE_PARTIALLY_FREEZE_ACCOUNT,
    )?;

    require!(balance > 0, ErrorCode::InvalidFreezeAmount);

    // ── Set (or overwrite) the frozen balance ─────────────────────────────────
    let freeze_state = &mut ctx.accounts.freeze_state_pda;
    freeze_state.frozen_balance = balance;
    freeze_state.bump = ctx.bumps.freeze_state_pda;

    emit_cpi!(AccountPartiallyFrozen {
        mint: ctx.accounts.mint.key(),
        account: ctx.accounts.account.key(),
        frozen_balance: balance,
        operator: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct FreezeAccountPartial<'info> {
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

    /// CHECK: Address used as a seed for freeze_state_pda; not otherwise validated here.
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
        space = FreezeState::SPACE,
        seeds = [pda_seeds::FREEZE_STATE, mint.key().as_ref(), account.key().as_ref()],
        bump,
    )]
    pub freeze_state_pda: Account<'info, FreezeState>,

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
