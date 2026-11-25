use anchor_lang::prelude::*;
use common::program_ids as constants;
use common::state::{
    AssetClassVersion, AssetConfiguration, MintCompliance, Roles, TRANSFER_MODE_NONE,
};
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, require_role, roles,
};

use crate::errors::TransferControlError;
use crate::events::TransferControlModeSet;
use crate::registry::RegistryWriter;
use crate::state::TransferMode;

pub fn initialize(ctx: Context<SetMode>, mode: TransferMode) -> Result<()> {
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_CONTROL_LIST,
    )?;

    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    require_active(ctx.accounts.mint_compliance_pda.load()?)?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::TRANSFER_CONTROL_INITIALIZE,
    )?;

    require!(
        ctx.accounts.mint_compliance_pda.load()?.transfer_mode == TRANSFER_MODE_NONE,
        TransferControlError::TransferModeAlreadySet
    );

    RegistryWriter {
        registry_writer: &ctx.accounts.registry_writer,
        bump: ctx.bumps.registry_writer,
        mint: &ctx.accounts.mint,
    }
    .set_transfer_mode(
        ctx.accounts.mint_compliance_pda.as_ref(),
        mode.compliance_value(),
    )?;

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
        mut,
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

    /// CHECK: Address verified by seeds/bump; signs the hook setter CPI, which accepts
    /// only this PDA.
    #[account(seeds = [pda_seeds::REGISTRY_WRITER], bump)]
    pub registry_writer: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::TRANSFER_HOOK_PROGRAM_ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,
}
