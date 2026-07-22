use anchor_lang::prelude::*;
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, require_role, roles,
};

use crate::events::CouponRateSet;
use crate::state::Coupon;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};

pub fn set_coupon_rate(
    ctx: Context<SetCouponRate>,
    _coupon_id: u64,
    interest_rate: Option<u64>,
    interest_rate_decimals: Option<u8>,
) -> Result<()> {
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_CORPORATE_ACTION,
    )?;
    require_not_paused(&ctx.accounts.mint.to_account_info())?;
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;
    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::COUPON_SET_COUPON_RATE,
    )?;

    let coupon = &mut ctx.accounts.coupon;
    coupon.set_interest_rate(interest_rate, interest_rate_decimals)?;

    emit_cpi!(CouponRateSet {
        mint: ctx.accounts.mint.key(),
        coupon_id: _coupon_id,
        interest_rate_override: interest_rate,
        interest_rate_override_decimals: interest_rate_decimals
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(coupon_id: u64, interest_rate: Option<u64>, interest_rate_decimals: Option<u8>)]
pub struct SetCouponRate<'info> {
    pub authority: Signer<'info>,

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
        seeds = [pda_seeds::COUPON, mint.key().as_ref(), &coupon_id.to_le_bytes()],
        bump = coupon.bump,
    )]
    pub coupon: Account<'info, Coupon>,

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
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,
}
