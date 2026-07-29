use anchor_lang::prelude::*;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, require_role, roles,
};
use spl_token_2022_interface::extension::StateWithExtensions;
use spl_token_2022_interface::state::Mint;

use crate::errors::ErrorCode;
use crate::events::MaxSupplySet;
use crate::state::MaxSupply;
use common::program_ids as constants;

pub fn set_max_supply(ctx: Context<SetMaxSupply>, max_supply: u64) -> Result<()> {
    require_role(ctx.accounts.authority_roles_pda.load()?, roles::ROLE_CAP)?;

    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::CAP_MAX_SUPPLY,
    )?;

    require!(max_supply >= 1, ErrorCode::MaxSupplyTooLow);

    let mint_data = ctx.accounts.mint.try_borrow_data()?;
    let total_supply = StateWithExtensions::<Mint>::unpack(&mint_data)?.base.supply;
    drop(mint_data);

    require!(
        max_supply >= total_supply,
        ErrorCode::MaxSupplyBelowTotalSupply
    );

    let max_supply_pda = &mut ctx.accounts.max_supply_pda;
    max_supply_pda.bump = ctx.bumps.max_supply_pda;
    max_supply_pda.max_supply = max_supply;

    emit_cpi!(MaxSupplySet {
        mint: ctx.accounts.mint.key(),
        operator: ctx.accounts.authority.key(),
        max_supply,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetMaxSupply<'info> {
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

    /// CHECK: Read-only; pause state validated by require_not_paused, total supply unpacked in the handler.
    pub mint: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = MaxSupply::DISCRIMINATOR.len() + MaxSupply::INIT_SPACE,
        seeds = [pda_seeds::MAX_SUPPLY, mint.key().as_ref()],
        bump,
    )]
    pub max_supply_pda: Account<'info, MaxSupply>,

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
