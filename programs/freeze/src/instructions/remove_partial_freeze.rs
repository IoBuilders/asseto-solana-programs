use crate::events::AccountPartialFreezeRemoved;
use anchor_lang::prelude::*;
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, require_role, roles,
};

use crate::state::FrozenBalance;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};

/// Removes the frozen balance for a specific token account by closing the marker PDA.
///
/// The `frozen_balance_pda` (seeds: `["frozen_balance", mint, account]`) is closed
/// here and its rent lamports are returned to the caller.
///
/// Management instruction — only an account holding `ROLE_FREEZE_MANAGER` may call this.
pub fn remove_partial_freeze(ctx: Context<RemovePartialFreeze>) -> Result<()> {
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
        common::functionalities::FREEZE_REMOVE_PARTIAL_FREEZE,
    )?;

    emit_cpi!(AccountPartialFreezeRemoved {
        mint: ctx.accounts.mint.key(),
        account: ctx.accounts.account.key(),
        operator: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct RemovePartialFreeze<'info> {
    /// The caller — must sign and hold `ROLE_FREEZE_MANAGER`; receives the closed PDA's lamports.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The authority's own `Roles` PDA — read to verify `ROLE_FREEZE_MANAGER`.
    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, Roles>,

    /// PDA that contains the configuration for this mint.
    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// The Token-2022 mint.
    ///
    /// CHECK: Read-only; validated by require_not_paused (checks the Pausable extension).
    pub mint: UncheckedAccount<'info>,

    /// The token account whose partial freeze is being removed.
    ///
    /// CHECK: Address used as a seed for frozen_balance_pda; not otherwise validated here.
    pub account: UncheckedAccount<'info>,

    /// Deactivation marker PDA — must not exist for the instruction to proceed.
    /// Seeds: `["deactivate", mint]`, owned by `deactivate`.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// Frozen balance PDA — closed here; rent returned to the caller.
    /// Seeds: `["frozen_balance", mint, account]`.
    #[account(
        mut,
        close = authority,
        seeds = [pda_seeds::FROZEN_BALANCE, mint.key().as_ref(), account.key().as_ref()],
        bump = frozen_balance_pda.bump,
    )]
    pub frozen_balance_pda: Account<'info, FrozenBalance>,

    /// Asset-class version PDA this mint is hooked to.
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
