use anchor_lang::prelude::*;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, MintCompliance, Roles};
use common::{
    freeze_status, pda_seeds, require_active, require_functionality, require_not_paused,
    require_role, roles, CommonError,
};

use crate::events::AccountFrozen;
use crate::registry::RegistryWriter;

pub fn freeze_account<'info>(ctx: Context<'info, FreezeAccount<'info>>) -> Result<()> {
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_FREEZE_MANAGER,
    )?;

    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    require_active(ctx.accounts.mint_compliance_pda.load()?)?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::FREEZE_FREEZE_ACCOUNT,
    )?;

    let mut status = freeze_status(&ctx.accounts.account_compliance_pda)?;
    require!(!status.fully_frozen, CommonError::AccountFrozen);
    status.fully_frozen = true;
    RegistryWriter {
        registry_writer: &ctx.accounts.registry_writer,
        bump: ctx.bumps.registry_writer,
        mint: &ctx.accounts.mint,
    }
    .set_freeze(
        &ctx.accounts.authority,
        &ctx.accounts.system_program,
        &ctx.accounts.account,
        &ctx.accounts.account_compliance_pda,
        status,
    )?;

    emit_cpi!(AccountFrozen {
        mint: ctx.accounts.mint.key(),
        account: ctx.accounts.account.key(),
        operator: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct FreezeAccount<'info> {
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

    /// CHECK: Address used as a seed for account_compliance_pda; not otherwise validated here.
    pub account: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; may be empty (nothing recorded). Owner and
    /// discriminator checked by common::freeze_status; created/written by the
    /// transfer-hook::set_freeze CPI.
    #[account(
        mut,
        seeds = [pda_seeds::ACCOUNT_COMPLIANCE, mint.key().as_ref(), account.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump,
    )]
    pub account_compliance_pda: UncheckedAccount<'info>,

    #[account(
        seeds = [pda_seeds::MINT_COMPLIANCE, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump = mint_compliance_pda.load()?.bump,
    )]
    pub mint_compliance_pda: AccountLoader<'info, MintCompliance>,

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

    /// CHECK: Address verified by seeds/bump; signs the set_freeze CPI, which accepts
    /// only this PDA.
    #[account(seeds = [pda_seeds::REGISTRY_WRITER], bump)]
    pub registry_writer: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::TRANSFER_HOOK_PROGRAM_ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
