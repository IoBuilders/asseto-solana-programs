use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, require_role, roles,
};

use crate::errors::ErrorCode;
use crate::events::PaymentTokenSet;
use crate::state::TreasuryConfig;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};

pub fn set_payment_token(ctx: Context<SetPaymentToken>) -> Result<()> {
    // ── Auth + state checks ──────────────────────────────────────────────────
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_TREASURER,
    )?;
    require_not_paused(&ctx.accounts.mint.to_account_info())?;
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;
    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::TREASURY_SET_PAYMENT_TOKEN,
    )?;

    // ── Per-coupon claims guard ──────────────────────────────────────────────
    // CouponCounter layout: 8-byte discriminator | 1-byte bump | 8-byte count.
    // If the account doesn't exist yet (len < 17), no coupons have been
    // created and no claims are possible — skip the check.
    let locked_id = ctx.accounts.treasury_config.locked_for_coupon_id;
    if locked_id != 0 {
        let counter_data = ctx.accounts.coupon_counter.data.borrow();
        if counter_data.len() >= 17 {
            let current_count = u64::from_le_bytes(counter_data[9..17].try_into().unwrap());
            require!(locked_id < current_count, ErrorCode::ClaimsInProgress);
        }
    }

    // ── Write treasury_config (overwrite all fields) ─────────────────────────
    let cfg = &mut ctx.accounts.treasury_config;
    cfg.bump = ctx.bumps.treasury_config;
    cfg.payment_mint = ctx.accounts.payment_mint.key();
    cfg.payment_mint_decimals = ctx.accounts.payment_mint.decimals;

    // ── Emit PaymentTokenSet ─────────────────────────────────────────────────
    emit_cpi!(PaymentTokenSet {
        mint: ctx.accounts.mint.key(),
        payment_mint: ctx.accounts.payment_mint.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetPaymentToken<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

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
        init_if_needed,
        payer = payer,
        space = TreasuryConfig::DISCRIMINATOR.len() + TreasuryConfig::INIT_SPACE,
        seeds = [pda_seeds::TREASURY_CONFIG, mint.key().as_ref()],
        bump,
    )]
    pub treasury_config: Account<'info, TreasuryConfig>,

    /// CHECK: Address verified by seeds/bump; contents parsed manually in handler.
    #[account(
        seeds = [pda_seeds::COUPON_COUNTER, mint.key().as_ref()],
        seeds::program = constants::COUPON_PROGRAM_ID,
        bump,
    )]
    pub coupon_counter: UncheckedAccount<'info>,

    pub payment_mint: InterfaceAccount<'info, Mint>,

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

    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,
}
