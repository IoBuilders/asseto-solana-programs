use crate::events::Deactivated;
use crate::state::DeactivateStatus;
use anchor_lang::prelude::*;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};
use common::{pda_seeds, require_functionality, require_not_paused, require_role, roles};

/// Deactivates the Token-2022 mint by creating an on-chain marker PDA.
///
/// The `deactivate_pda` (seeds: `["deactivate", mint]`) is created here.
/// Its existence on-chain signals that the mint has been permanently deactivated.
pub fn deactivate(ctx: Context<Deactivate>) -> Result<()> {
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_DEACTIVATE,
    )?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::DEACTIVATE_DEACTIVATE,
    )?;

    // ── Record canonical bump in the deactivation marker PDA ─────────────────
    ctx.accounts.deactivate_pda.bump = ctx.bumps.deactivate_pda;

    emit_cpi!(Deactivated {
        mint: ctx.accounts.mint.key(),
        operator: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct Deactivate<'info> {
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

    /// PDA that contains the configuration for this mint.
    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// The Token-2022 mint to deactivate.
    ///
    /// CHECK: Read-only; validated by require_not_paused (checks the Pausable extension).
    pub mint: UncheckedAccount<'info>,

    /// Deactivation marker PDA — created here to record that this mint has been deactivated.
    /// Seeds: `["deactivate", mint]`.
    #[account(
        init,
        payer = authority,
        space = DeactivateStatus::DISCRIMINATOR.len() + DeactivateStatus::INIT_SPACE,
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        bump,
    )]
    pub deactivate_pda: Account<'info, DeactivateStatus>,

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
