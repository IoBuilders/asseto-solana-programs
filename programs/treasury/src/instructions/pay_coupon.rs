use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use bond::state::{BondTerms, DayCountConvention};
use common::{
    pda_seeds, pda_utils, require_active, require_balance_proof, require_functionality,
    require_not_paused, require_role, roles,
};
use coupon::state::Coupon;
use snapshot::state::SnapshotMerkleRoot;

use crate::errors::ErrorCode;
use crate::events::CouponPaid;
use crate::state::{CouponPaidMarker, TreasuryConfig};
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};

pub fn pay_coupon(
    ctx: Context<PayCoupon>,
    coupon_id: u64,
    account: Pubkey,
    balance: u64,
    merkle_proof: Vec<[u8; 32]>,
) -> Result<()> {
    // ── Auth + state checks ──────────────────────────────────────────────────
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_TREASURER,
    )?;
    require_not_paused(&ctx.accounts.mint.to_account_info())?;
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;
    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::TREASURY_PAY_COUPON,
    )?;

    let coupon = &ctx.accounts.coupon;
    let now = Clock::get()?.unix_timestamp;
    require!(now >= coupon.payment_date, ErrorCode::CouponNotMature);

    require_balance_proof(
        &merkle_proof,
        ctx.accounts.snapshot_merkle_root.merkle_root,
        account,
        balance,
    )?;

    // ── Compute payout amount ────────────────────────────────────────────────
    let bond = &ctx.accounts.bond_terms;
    let elapsed_seconds: i64 = coupon
        .period_end_date
        .checked_sub(coupon.period_start_date)
        .ok_or(ErrorCode::NegativeElapsedTime)?;
    require!(elapsed_seconds > 0, ErrorCode::NegativeElapsedTime);
    let elapsed_seconds: u64 = elapsed_seconds as u64;

    let day_count_days: u64 = match bond.day_count_convention {
        DayCountConvention::Actual360 => 360,
        DayCountConvention::Actual365 => 365,
    };
    const SECONDS_PER_DAY: u64 = 86_400;

    let (effective_interest_rate, effective_interest_rate_decimals) = match (
        coupon.interest_rate_override,
        coupon.interest_rate_override_decimals,
    ) {
        (Some(rate), Some(dec)) => (rate, dec),
        _ => (bond.interest_rate, bond.interest_rate_decimals),
    };

    // i32 is wide enough: each input is u8, so the sum is bounded by 4·255 = 1020.
    let bond_mint_dec = ctx.accounts.mint.decimals;
    let payment_mint_dec = ctx.accounts.treasury_config.payment_mint_decimals;
    let positive_decs: i32 = effective_interest_rate_decimals as i32
        + bond_mint_dec as i32
        + bond.par_value_decimals as i32;
    let net_power: i32 = payment_mint_dec as i32 - positive_decs;

    let mut num: u128 = (effective_interest_rate as u128)
        .checked_mul(balance as u128)
        .and_then(|v| v.checked_mul(bond.par_value as u128))
        .and_then(|v| v.checked_mul(elapsed_seconds as u128))
        .ok_or(ErrorCode::AmountOverflow)?;

    let mut den: u128 = (day_count_days as u128)
        .checked_mul(SECONDS_PER_DAY as u128)
        .ok_or(ErrorCode::AmountOverflow)?;

    if net_power >= 0 {
        let mul: u128 = 10u128
            .checked_pow(net_power as u32)
            .ok_or(ErrorCode::AmountOverflow)?;
        num = num.checked_mul(mul).ok_or(ErrorCode::AmountOverflow)?;
    } else {
        let div: u128 = 10u128
            .checked_pow((-net_power) as u32)
            .ok_or(ErrorCode::AmountOverflow)?;
        den = den.checked_mul(div).ok_or(ErrorCode::AmountOverflow)?;
    }

    let amount: u64 = (num / den)
        .try_into()
        .map_err(|_| ErrorCode::AmountOverflow)?;

    let cfg = &ctx.accounts.treasury_config;
    let mint_key = ctx.accounts.mint.key();
    let treasury_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::treasury_authority_seeds(&mint_key),
        &ctx.bumps.treasury_authority,
    );

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.treasury_token_account.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.holder_payment_account.to_account_info(),
                authority: ctx.accounts.treasury_authority.to_account_info(),
            },
            &[treasury_authority_signer_seeds.as_slice()],
        ),
        amount,
        cfg.payment_mint_decimals,
    )?;

    // ── Lock the treasury config for this coupon ─────────────────────────────
    ctx.accounts.treasury_config.locked_for_coupon_id = coupon_id;

    let marker = &mut ctx.accounts.coupon_paid;
    marker.bump = ctx.bumps.coupon_paid;
    marker.amount = amount;

    // ── Emit CouponPaid ──────────────────────────────────────────────────────
    emit_cpi!(CouponPaid {
        mint: mint_key,
        coupon_id,
        holder_token_account: account,
        payment_mint: ctx.accounts.payment_mint.key(),
        amount,
        payer: ctx.accounts.payer.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(coupon_id: u64, account: Pubkey)]
pub struct PayCoupon<'info> {
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

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [pda_seeds::TREASURY_CONFIG, mint.key().as_ref()],
        bump = treasury_config.bump,
    )]
    pub treasury_config: Box<Account<'info, TreasuryConfig>>,

    /// CHECK: PDA address verified by seeds/bump; signs via invoke_signed.
    #[account(
        seeds = [pda_seeds::TREASURY_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub treasury_authority: UncheckedAccount<'info>,

    #[account(
        address = treasury_config.payment_mint,
        mint::token_program = token_program,
    )]
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = treasury_authority,
        token::token_program = token_program,
    )]
    pub treasury_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = payment_mint,
        token::token_program = token_program,
    )]
    pub holder_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        seeds = [pda_seeds::BOND_TERMS, mint.key().as_ref()],
        seeds::program = constants::BOND_PROGRAM_ID,
        bump = bond_terms.bump,
    )]
    pub bond_terms: Box<Account<'info, BondTerms>>,

    #[account(
        seeds = [pda_seeds::COUPON, mint.key().as_ref(), &coupon_id.to_le_bytes()],
        seeds::program = constants::COUPON_PROGRAM_ID,
        bump = coupon.bump,
    )]
    pub coupon: Box<Account<'info, Coupon>>,

    #[account(
        seeds = [pda_seeds::SNAPSHOT_MERKLE_ROOT, mint.key().as_ref(), &coupon.snapshot_id.to_le_bytes()],
        seeds::program = constants::SNAPSHOT_PROGRAM_ID,
        bump = snapshot_merkle_root.bump,
    )]
    pub snapshot_merkle_root: Box<Account<'info, SnapshotMerkleRoot>>,

    #[account(
        init,
        payer = payer,
        space = CouponPaidMarker::DISCRIMINATOR.len() + CouponPaidMarker::INIT_SPACE,
        seeds = [
            pda_seeds::COUPON_PAID,
            mint.key().as_ref(),
            &coupon_id.to_le_bytes(),
            account.as_ref(),
        ],
        bump,
    )]
    pub coupon_paid: Box<Account<'info, CouponPaidMarker>>,

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

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,

    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,
}
