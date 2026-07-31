use crate::events::CouponCreated;
use anchor_lang::prelude::*;
use common::{
    pda_seeds, pda_utils, require_active, require_functionality, require_not_paused, require_role,
    roles,
};
use snapshot::cpi::accounts::TakeSnapshot;
use snapshot::state::SnapshotCounter;

use crate::errors::ErrorCode;
use crate::state::{Coupon, CouponCounter};
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};

pub fn create_coupon<'info>(
    ctx: Context<'info, CreateCoupon<'info>>,
    period_start_date: i64,
    period_end_date: i64,
    payment_date: i64,
    coupon_id: u64,
    interest_rate_override: Option<u64>,
    interest_rate_override_decimals: Option<u8>,
    merkle_root: [u8; 32],
) -> Result<()> {
    // ── Auth + state checks ──────────────────────────────────────────────────
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_CORPORATE_ACTION,
    )?;
    require_not_paused(&ctx.accounts.mint.to_account_info())?;
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;
    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::COUPON_CREATE_COUPON,
    )?;

    // ── Date-triple validation ───────────────────────────────────────────────
    require!(
        period_end_date > period_start_date,
        ErrorCode::InvalidCouponPeriod
    );
    require!(
        payment_date > period_end_date,
        ErrorCode::InvalidPaymentDate
    );

    // ── Increment coupon_counter and re-check the supplied id ────────────────
    let counter = &mut ctx.accounts.coupon_counter;
    let expected_id = if counter.count == 0 {
        counter.bump = ctx.bumps.coupon_counter;
        1u64
    } else {
        counter
            .count
            .checked_add(1)
            .ok_or(ErrorCode::CouponCounterOverflow)?
    };
    require!(coupon_id == expected_id, ErrorCode::InvalidCouponId);
    counter.count = expected_id;

    // ── Read the snapshot id take_snapshot is about to assign ────────────────
    // `snapshot_counter.count` holds the id of the *next* snapshot (the value
    // take_snapshot uses as-is), so we must read it BEFORE the CPI — afterwards
    // the counter has already been bumped to the following id. When the counter
    // PDA doesn't exist yet this is the first snapshot, id = 0.
    let snapshot_id = {
        let acct = &ctx.accounts.snapshot_counter;
        if acct.data_is_empty() {
            0
        } else {
            Account::<SnapshotCounter>::try_from(acct)?.count
        }
    };

    // ── CPI: take_snapshot, signed by coupon_authority PDA ───────────────────
    let mint_key = ctx.accounts.mint.key();
    let coupon_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::coupon_authority_seeds(&mint_key),
        &ctx.bumps.coupon_authority,
    );

    snapshot::cpi::take_snapshot(
        CpiContext::new_with_signer(
            constants::SNAPSHOT_PROGRAM_ID,
            TakeSnapshot {
                calling_authority: ctx.accounts.coupon_authority.to_account_info(),
                payer: ctx.accounts.payer.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                snapshot_counter: ctx.accounts.snapshot_counter.to_account_info(),
                snapshot_merkle_root: ctx.accounts.snapshot_merkle_root.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                event_authority: ctx.accounts.snapshot_event_authority.to_account_info(),
                program: ctx.accounts.snapshot_program.to_account_info(),
            },
            &[coupon_authority_signer_seeds.as_slice()],
        ),
        merkle_root,
    )?;

    // ── Write the coupon ─────────────────────────────────────────────────────
    let coupon = &mut ctx.accounts.coupon;
    coupon.bump = ctx.bumps.coupon;
    coupon.snapshot_id = snapshot_id;
    coupon.period_start_date = period_start_date;
    coupon.period_end_date = period_end_date;
    coupon.payment_date = payment_date;
    coupon.set_interest_rate(interest_rate_override, interest_rate_override_decimals)?;

    emit_cpi!(CouponCreated {
        mint: ctx.accounts.mint.key(),
        coupon_id,
        period_start_date,
        period_end_date,
        payment_date,
        interest_rate_override,
        interest_rate_override_decimals
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(period_start_date: i64, period_end_date: i64, payment_date: i64, coupon_id: u64)]
pub struct CreateCoupon<'info> {
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

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::COUPON_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub coupon_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = CouponCounter::DISCRIMINATOR.len() + CouponCounter::INIT_SPACE,
        seeds = [pda_seeds::COUPON_COUNTER, mint.key().as_ref()],
        bump,
    )]
    pub coupon_counter: Account<'info, CouponCounter>,

    #[account(
        init,
        payer = payer,
        space = Coupon::DISCRIMINATOR.len() + Coupon::INIT_SPACE,
        seeds = [pda_seeds::COUPON, mint.key().as_ref(), &coupon_id.to_le_bytes()],
        bump,
    )]
    pub coupon: Account<'info, Coupon>,

    /// CHECK: Writable; address verified by seeds/bump; ownership and contents
    /// validated inside `take_snapshot`.
    #[account(
        mut,
        seeds = [pda_seeds::SNAPSHOT_COUNTER, mint.key().as_ref()],
        seeds::program = constants::SNAPSHOT_PROGRAM_ID,
        bump,
    )]
    pub snapshot_counter: UncheckedAccount<'info>,

    /// CHECK: Writable; address verified and account created inside snapshot::take_snapshot.
    #[account(mut)]
    pub snapshot_merkle_root: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::SNAPSHOT_PROGRAM_ID)]
    pub snapshot_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Address verified by snapshot program.
    pub snapshot_event_authority: UncheckedAccount<'info>,

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
