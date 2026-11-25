use crate::events::Deactivated;
use anchor_lang::prelude::*;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, MintCompliance, Roles};
use common::{
    pda_seeds, pda_utils, require_active, require_functionality, require_not_paused, require_role,
    roles,
};
use transfer_hook::cpi::accounts::SetDeactivated;

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

    require_active(ctx.accounts.mint_compliance_pda.load()?)?;

    let registry_writer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::registry_writer_seeds(),
        &ctx.bumps.registry_writer,
    );
    transfer_hook::cpi::set_deactivated(CpiContext::new_with_signer(
        constants::TRANSFER_HOOK_PROGRAM_ID,
        SetDeactivated {
            registry_writer: ctx.accounts.registry_writer.to_account_info(),
            mint_compliance_pda: ctx.accounts.mint_compliance_pda.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
        },
        &[registry_writer_seeds.as_slice()],
    ))?;

    emit_cpi!(Deactivated {
        mint: ctx.accounts.mint.key(),
        operator: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct Deactivate<'info> {
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

    #[account(
        mut,
        seeds = [pda_seeds::MINT_COMPLIANCE, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump = mint_compliance_pda.load()?.bump,
    )]
    pub mint_compliance_pda: AccountLoader<'info, MintCompliance>,

    /// CHECK: Address verified by seeds/bump; signs the set_deactivated CPI, which
    /// accepts only this PDA.
    #[account(seeds = [pda_seeds::REGISTRY_WRITER], bump)]
    pub registry_writer: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::TRANSFER_HOOK_PROGRAM_ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,
}
