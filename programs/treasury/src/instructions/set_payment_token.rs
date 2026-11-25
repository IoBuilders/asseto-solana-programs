use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, require_role, roles,
};

use crate::events::PaymentTokenSet;
use crate::state::TreasuryConfig;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, MintCompliance, Roles as RolesCommon};

pub fn set_payment_token(ctx: Context<SetPaymentToken>) -> Result<()> {
    // ── Auth + state checks ──────────────────────────────────────────────────
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_TREASURER,
    )?;
    require_not_paused(&ctx.accounts.mint.to_account_info())?;
    require_active(ctx.accounts.mint_compliance_pda.load()?)?;
    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::TREASURY_SET_PAYMENT_TOKEN,
    )?;

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

    #[account(
        seeds = [pda_seeds::MINT_COMPLIANCE, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump = mint_compliance_pda.load()?.bump,
    )]
    pub mint_compliance_pda: AccountLoader<'info, MintCompliance>,

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
