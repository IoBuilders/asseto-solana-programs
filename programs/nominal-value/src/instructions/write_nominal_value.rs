use anchor_lang::prelude::*;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, require_role, roles,
};

use crate::errors::ErrorCode;
use crate::events::{NominalValuePublished, NominalValueRepublished};
use crate::state::NominalValue;

pub fn publish_nominal_value(
    ctx: Context<WriteNominalValue>,
    nominal_value: u128,
    effective_datetime: i64,
) -> Result<()> {
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_NOMINAL_VALUE,
    )?;

    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::NOMINAL_VALUE_PUBLISH,
    )?;

    let nominal_value_account = &mut ctx.accounts.nominal_value_pda;

    require!(effective_datetime > 0, ErrorCode::InvalidTimestamp);

    require!(
        effective_datetime > nominal_value_account.effective_datetime,
        ErrorCode::EffectiveDatetimeNotAfterCurrent
    );

    require!(
        effective_datetime < Clock::get()?.unix_timestamp,
        ErrorCode::EffectiveDatetimeNotInPast
    );

    nominal_value_account.nominal_value = nominal_value;
    nominal_value_account.effective_datetime = effective_datetime;

    emit_cpi!(NominalValuePublished {
        mint: ctx.accounts.mint.key(),
        operator: ctx.accounts.authority.key(),
        nominal_value,
        effective_datetime,
    });

    Ok(())
}

pub fn republish_nominal_value(
    ctx: Context<WriteNominalValue>,
    nominal_value: u128,
    effective_datetime: i64,
) -> Result<()> {
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_NOMINAL_VALUE,
    )?;

    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::NOMINAL_VALUE_REPUBLISH,
    )?;

    let nominal_value_account = &mut ctx.accounts.nominal_value_pda;

    require!(effective_datetime > 0, ErrorCode::InvalidTimestamp);

    require!(
        effective_datetime == nominal_value_account.effective_datetime,
        ErrorCode::EffectiveDatetimeMismatch
    );

    nominal_value_account.nominal_value = nominal_value;

    emit_cpi!(NominalValueRepublished {
        mint: ctx.accounts.mint.key(),
        operator: ctx.accounts.authority.key(),
        nominal_value,
        effective_datetime,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct WriteNominalValue<'info> {
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
        mut,
        seeds = [pda_seeds::NOMINAL_VALUE, mint.key().as_ref()],
        bump = nominal_value_pda.bump,
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
}
