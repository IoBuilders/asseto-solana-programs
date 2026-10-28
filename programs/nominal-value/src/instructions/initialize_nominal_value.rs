use anchor_lang::prelude::*;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, require_role, roles,
};

use crate::events::NominalValueInitialized;
use crate::state::{NominalValue, NominalValuePublishType};

pub fn initialize_nominal_value(
    ctx: Context<InitializeNominalValue>,
    nominal_value_decimals: u8,
    nominal_value_currency: [u8; 3],
    nominal_value_publish_type: NominalValuePublishType,
) -> Result<()> {
    require_role(ctx.accounts.authority_roles_pda.load()?, roles::ROLE_ADMIN)?;

    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::NOMINAL_VALUE_INITIALIZE,
    )?;

    let nominal_value_account = &mut ctx.accounts.nominal_value_pda;
    nominal_value_account.bump = ctx.bumps.nominal_value_pda;
    nominal_value_account.nominal_value_currency = nominal_value_currency;
    nominal_value_account.nominal_value_publish_type = nominal_value_publish_type;
    nominal_value_account.nominal_value_decimals = nominal_value_decimals;
    nominal_value_account.nominal_value = 0;
    nominal_value_account.effective_datetime = 0;

    emit_cpi!(NominalValueInitialized {
        mint: ctx.accounts.mint.key(),
        operator: ctx.accounts.authority.key(),
        nominal_value_decimals,
        nominal_value_currency,
        nominal_value_publish_type,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct InitializeNominalValue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

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

    /// CHECK: Read-only; pause state validated by require_not_paused.
    pub mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = NominalValue::DISCRIMINATOR.len() + NominalValue::INIT_SPACE,
        seeds = [pda_seeds::NOMINAL_VALUE, mint.key().as_ref()],
        bump,
    )]
    pub nominal_value_pda: Account<'info, NominalValue>,

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
