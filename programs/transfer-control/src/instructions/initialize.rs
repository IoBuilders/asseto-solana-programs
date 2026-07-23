use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use common::{
    pda_seeds, pda_utils, require_active, require_functionality, require_not_paused, require_role,
    roles,
};

use crate::events::TransferControlModeSet;
use crate::state::{TransferControlMode, TransferMode};
use common::program_ids as constants;
use common::state::{AssetClassVersion, MintOwner, Roles};

/// Initializes the transfer control modes for a mint.
///
/// Management instruction — only an authority with role `ROLE_CONTROL_LIST` may call this.
pub fn initialize(ctx: Context<SetMode>, mode: TransferMode) -> Result<()> {
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
        common::functionalities::TRANSFER_CONTROL_INITIALIZE,
    )?;

    ctx.accounts.transfer_control_mode_pda.bump = ctx.bumps.transfer_control_mode_pda;
    ctx.accounts.transfer_control_mode_pda.mode = mode;

    emit_cpi!(TransferControlModeSet {
        mint: ctx.accounts.mint.key(),
        operator: ctx.accounts.authority.key(),
        mode,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetMode<'info> {
    /// The authority — must sign and fund the PDA creation.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The authority's own `Roles` PDA.
    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, Roles>,

    /// PDA created by deploy that records the configuration for this mint.
    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = mint_owner_pda.bump,
    )]
    pub mint_owner_pda: Account<'info, MintOwner>,

    /// The Token-2022 mint.
    ///
    /// CHECK: Read-only; validated by require_not_paused (checks the Pausable extension).
    pub mint: UncheckedAccount<'info>,

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

    /// Transfer Control Mode PDA.
    #[account(
        init,
        payer = authority,
        space = TransferControlMode::DISCRIMINATOR.len() + TransferControlMode::INIT_SPACE,
        seeds = [pda_seeds::TRANSFER_CONTROL_MODE, mint.key().as_ref()],
        bump,
    )]
    pub transfer_control_mode_pda: Account<'info, TransferControlMode>,

    /// Asset-class version PDA this mint is hooked to.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &mint_owner_pda.asset_class_config_id.to_le_bytes(), &mint_owner_pda.asset_class_version_id.to_le_bytes()],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    pub system_program: Program<'info, System>,
}
