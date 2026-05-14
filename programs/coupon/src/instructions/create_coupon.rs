use anchor_lang::prelude::*;
use common::{pda_seeds, pda_utils, require_active, require_not_paused, verify_deployer};
use snapshot::cpi::accounts::TakeSnapshot;
use snapshot::state::SnapshotCounter;

use common::program_ids as constants;
use crate::errors::ErrorCode;
use crate::state::{Coupon, CouponCounter};

/// Creates a coupon for the mint:
/// 1. Verifies the deployer signature, mint not paused, mint not deactivated.
/// 2. Validates the date triple: `period_start_date < period_end_date < payment_date`
///    (strict, not enforcing chaining with previous coupons).
/// 3. Increments `coupon_counter` (creating it on the first call).
/// 4. CPIs `snapshot::take_snapshot` signed by the `coupon_authority` PDA.
/// 5. Reads the resulting snapshot id from `snapshot_counter`.
/// 6. Stores `(snapshot_id, period_start_date, period_end_date, payment_date)`
///    in the new `coupon` PDA.
///
/// `coupon_id` is supplied by the client (it's needed in the seeds for the
/// `coupon` PDA address derivation) and the program re-checks it equals the
/// expected new counter value before committing.
pub fn create_coupon(
    ctx: Context<CreateCoupon>,
    period_start_date: i64,
    period_end_date: i64,
    payment_date: i64,
    coupon_id: u64,
) -> Result<()> {
    // ── Auth + state checks ──────────────────────────────────────────────────
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;
    require_not_paused(&ctx.accounts.mint.to_account_info())?;
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    // ── Date-triple validation ───────────────────────────────────────────────
    require!(period_end_date > period_start_date, ErrorCode::InvalidCouponPeriod);
    require!(payment_date > period_end_date, ErrorCode::InvalidPaymentDate);

    // ── Increment coupon_counter and re-check the supplied id ────────────────
    let counter = &mut ctx.accounts.coupon_counter;
    let expected_id = if counter.count == 0 {
        counter.bump = ctx.bumps.coupon_counter;
        1u64
    } else {
        counter.count.checked_add(1).unwrap()
    };
    require!(coupon_id == expected_id, ErrorCode::InvalidCouponId);
    counter.count = expected_id;

    // ── CPI: take_snapshot, signed by coupon_authority PDA ───────────────────
    let mint_key = ctx.accounts.mint.key();
    let coupon_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::coupon_authority_seeds(&mint_key),
        &ctx.bumps.coupon_authority
    );

    snapshot::cpi::take_snapshot(
        CpiContext::new_with_signer(
            ctx.accounts.snapshot_program.to_account_info(),
            TakeSnapshot {
                calling_authority: ctx.accounts.coupon_authority.to_account_info(),
                payer: ctx.accounts.payer.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                snapshot_counter: ctx.accounts.snapshot_counter.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[coupon_authority_signer_seeds.as_slice()],
        ),
    )?;

    // ── Read the snapshot id that take_snapshot just wrote ───────────────────
    let snapshot_id = {
        let data = ctx.accounts.snapshot_counter.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        SnapshotCounter::try_deserialize(&mut slice)?.count
    };

    // ── Write the coupon ─────────────────────────────────────────────────────
    let coupon = &mut ctx.accounts.coupon;
    coupon.bump = ctx.bumps.coupon;
    coupon.snapshot_id = snapshot_id;
    coupon.period_start_date = period_start_date;
    coupon.period_end_date = period_end_date;
    coupon.payment_date = payment_date;

    Ok(())
}

#[derive(Accounts)]
#[instruction(period_start_date: i64, period_end_date: i64, payment_date: i64, coupon_id: u64)]
pub struct CreateCoupon<'info> {
    /// Funds rent for the new PDAs (`coupon_counter` on first call, `coupon`
    /// always, and `snapshot_counter` when this is the very first snapshot).
    /// Distinct from `deployer` so a wallet can pay without holding the
    /// mint-owner signature.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The deployer recorded as mint owner — must sign to authorise the coupon.
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
    /// Seeds: `["deactivate", mint]`, owned by `deactivate`.
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

    /// Signer for the `take_snapshot` CPI. Address verified by seeds/bump
    /// here, signs via `invoke_signed` inside the handler.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::COUPON_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub coupon_authority: UncheckedAccount<'info>,

    /// Per-mint coupon counter — created on the first call, incremented after.
    /// Seeds: `["coupon_counter", mint]`.
    #[account(
        init_if_needed,
        payer = payer,
        space = CouponCounter::DISCRIMINATOR.len() + CouponCounter::INIT_SPACE,
        seeds = [pda_seeds::COUPON_COUNTER, mint.key().as_ref()],
        bump,
    )]
    pub coupon_counter: Account<'info, CouponCounter>,

    /// The new coupon PDA. Seeds: `["coupon", mint, coupon_id.to_le_bytes()]`.
    /// `coupon_id` is checked against `coupon_counter.count + 1` in the handler.
    #[account(
        init,
        payer = payer,
        space = Coupon::DISCRIMINATOR.len() + Coupon::INIT_SPACE,
        seeds = [pda_seeds::COUPON, mint.key().as_ref(), &coupon_id.to_le_bytes()],
        bump,
    )]
    pub coupon: Account<'info, Coupon>,

    /// `snapshot`'s `snapshot_counter` PDA — passed through to the CPI
    /// and re-read after to learn the snapshot id just allocated.
    ///
    /// CHECK: Writable; address verified by seeds/bump; ownership and contents
    /// validated inside `take_snapshot`.
    #[account(
        mut,
        seeds = [pda_seeds::SNAPSHOT_COUNTER, mint.key().as_ref()],
        seeds::program = constants::SNAPSHOT_PROGRAM_ID,
        bump,
    )]
    pub snapshot_counter: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::SNAPSHOT_PROGRAM_ID)]
    pub snapshot_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
