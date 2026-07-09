use anchor_lang::prelude::*;
use common::{pda_seeds, require_active, require_not_paused, verify_deployer};

use crate::events::CouponRateSet;
use crate::state::Coupon;
use common::program_ids as constants;

/// Overrides the interest rate for a single, already-issued coupon.
///
/// By default, every coupon inherits the asset-level rate from `bond_terms`
/// when `treasury::pay_coupon` runs. Calling this instruction stores a
/// coupon-specific rate that `pay_coupon` will use instead — the override
/// follows the same scaling convention as `BondTerms`:
/// actual rate = `interest_rate / 10^interest_rate_decimals`.
///
/// Passing `None` for `interest_rate` clears any existing override, reverting
/// the coupon to the asset-level rate. Passing `Some(rate)` replaces the
/// previous override (calling a second time is idempotent in structure).
///
/// Management instruction — gated by `verify_deployer`, `require_not_paused`,
/// and `require_active`.
pub fn set_coupon_rate(
    ctx: Context<SetCouponRate>,
    _coupon_id: u64,
    interest_rate: Option<u64>,
    interest_rate_decimals: Option<u8>,
) -> Result<()> {
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;
    require_not_paused(&ctx.accounts.mint.to_account_info())?;
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

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
    /// The deployer recorded as mint owner — must sign to authorise the change.
    pub deployer: Signer<'info>,

    /// PDA created by deploy that records the deployer for this mint.
    ///
    /// CHECK: Address verified by seeds/bump; contents Anchor-deserialized by verify_deployer.
    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub mint_owner_pda: UncheckedAccount<'info>,

    /// Deactivation marker PDA — must not exist for the instruction to proceed.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// The Token-2022 mint — must not be paused.
    ///
    /// CHECK: Read-only; pause state validated by require_not_paused.
    pub mint: UncheckedAccount<'info>,

    /// The coupon record to update. Must already exist (created by `create_coupon`).
    /// Seeds: `["coupon", mint, coupon_id.to_le_bytes()]`.
    #[account(
        mut,
        seeds = [pda_seeds::COUPON, mint.key().as_ref(), &coupon_id.to_le_bytes()],
        bump = coupon.bump,
    )]
    pub coupon: Account<'info, Coupon>,
}
