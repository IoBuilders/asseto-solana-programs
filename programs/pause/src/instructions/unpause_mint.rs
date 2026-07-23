use crate::events::Unpaused;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use common::{pda_seeds, require_active};
use common::{pda_utils, require_functionality, require_role, roles};
use spl_token_2022::extension::pausable::instruction::resume as spl_resume;

use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};

pub fn unpause(ctx: Context<UnpauseMint>) -> Result<()> {
    // ── Verify caller holds the pauser role ──────────────────────────────────
    require_role(ctx.accounts.authority_roles_pda.load()?, roles::ROLE_PAUSER)?;

    // ── Verify mint has not been deactivated ─────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::PAUSE_UNPAUSE,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let pausable_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::pausable_authority_seeds(&mint_key),
        &ctx.bumps.pausable_authority,
    );

    // ── Resume via this program's PDA ────────────────────────────────────────
    invoke_signed(
        &spl_resume(
            &token_program_id,
            &mint_key,
            &ctx.accounts.pausable_authority.key(),
            &[],
        )
        .map_err(Error::from)?,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.pausable_authority.to_account_info(),
        ],
        &[pausable_authority_signer_seeds.as_slice()],
    )?;

    emit_cpi!(Unpaused {
        mint: mint_key,
        operator: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct UnpauseMint<'info> {
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

    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// CHECK: Writable; validated by Token-2022 during the resume CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::PAUSABLE_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub pausable_authority: UncheckedAccount<'info>,

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

    pub token_2022_program: Program<'info, Token2022>,
}
