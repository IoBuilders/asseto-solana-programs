use anchor_lang::prelude::*;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, require_role, roles,
};

use crate::events::BondTermsUpdated;
use crate::state::{BondTerms, BondTermsArgs};
use common::program_ids as constants;

pub fn update_bond_terms(ctx: Context<UpdateBondTerms>, args: BondTermsArgs) -> Result<()> {
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_CORPORATE_ACTION,
    )?;

    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::BOND_UPDATE_BOND_TERMS,
    )?;

    let bond_terms = &mut ctx.accounts.bond_terms;
    bond_terms.bump = ctx.bumps.bond_terms;
    bond_terms.interest_rate = args.interest_rate;
    bond_terms.interest_rate_decimals = args.interest_rate_decimals;
    bond_terms.par_value = args.par_value;
    bond_terms.par_value_decimals = args.par_value_decimals;
    bond_terms.minimum_denomination = args.minimum_denomination;
    bond_terms.issuance_date = args.issuance_date;
    bond_terms.day_count_convention = args.day_count_convention;

    emit_cpi!(BondTermsUpdated {
        mint: ctx.accounts.mint.key(),
        operator: ctx.accounts.authority.key(),
        interest_rate: args.interest_rate,
        interest_rate_decimals: args.interest_rate_decimals,
        par_value: args.par_value,
        par_value_decimals: args.par_value_decimals,
        minimum_denomination: args.minimum_denomination,
        issuance_date: args.issuance_date,
        day_count_convention: args.day_count_convention,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct UpdateBondTerms<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

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
        init_if_needed,
        payer = payer,
        space = BondTerms::DISCRIMINATOR.len() + BondTerms::INIT_SPACE,
        seeds = [pda_seeds::BOND_TERMS, mint.key().as_ref()],
        bump,
    )]
    pub bond_terms: Account<'info, BondTerms>,

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
