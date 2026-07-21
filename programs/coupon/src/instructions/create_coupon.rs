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
use common::state::{AssetClassVersion, MintOwner, Roles as RolesCommon};

/// Creates a coupon for the mint:
/// 1. Verifies the authority role, mint not paused, mint not deactivated.
/// 2. Validates the date triple: `period_start_date < period_end_date < payment_date`
///    (strict, not enforcing chaining with previous coupons).
/// 3. Validates that `interest_rate_override` and `interest_rate_override_decimals`
///    are either both `Some` or both `None` (`InconsistentRateOverride` otherwise).
/// 4. Increments `coupon_counter` (creating it on the first call).
/// 5. CPIs `snapshot::take_snapshot` (forwarding `merkle_root`) signed by the
///    `coupon_authority` PDA. `take_snapshot` stores the root in a new immutable
///    `snapshot_merkle_root` PDA keyed by the freshly-allocated snapshot id.
/// 6. Reads the resulting snapshot id from `snapshot_counter`.
/// 7. Stores `(snapshot_id, period_start_date, period_end_date, payment_date,
///    interest_rate_override, interest_rate_override_decimals)` in the new `coupon` PDA.
///
/// `coupon_id` is supplied by the client (it's needed in the seeds for the
/// `coupon` PDA address derivation) and the program re-checks it equals the
/// expected new counter value before committing.
///
/// `interest_rate_override` / `interest_rate_override_decimals` are optional.
/// When both are `Some`, `treasury::pay_coupon` uses them instead of the
/// asset-level rate in `bond_terms`. Pass `None` for both to inherit the
/// bond-level rate (the default). The rate can be updated later with
/// `set_coupon_rate`.
pub fn create_coupon(
    ctx: Context<CreateCoupon>,
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
    /// Funds rent for the new PDAs (`coupon_counter` on first call, `coupon`
    /// always, and `snapshot_counter` when this is the very first snapshot).
    /// Distinct from `authority` so a wallet can pay without holding the
    /// mint-owner signature.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub authority: Signer<'info>,

    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = mint_owner_pda.bump,
    )]
    pub mint_owner_pda: Account<'info, MintOwner>,

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

    /// The immutable Merkle-root PDA that `take_snapshot` creates for the new
    /// snapshot. Its address depends on the snapshot id, only known inside
    /// `take_snapshot` after the counter increments, so it's forwarded
    /// unchecked; the snapshot program derives, verifies, and creates it.
    /// Seeds: `["snapshot_merkle_root", mint, snapshot_id]`, owned by snapshot.
    ///
    /// CHECK: Writable; address verified and account created inside snapshot::take_snapshot.
    #[account(mut)]
    pub snapshot_merkle_root: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::SNAPSHOT_PROGRAM_ID)]
    pub snapshot_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Address verified by snapshot program.
    pub snapshot_event_authority: UncheckedAccount<'info>,

    /// Asset-class version PDA this mint is hooked to.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &mint_owner_pda.asset_class_config_id.to_le_bytes(), &mint_owner_pda.asset_class_version_id.to_le_bytes()],
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
