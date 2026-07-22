use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use bond::state::{BondTerms, DayCountConvention};
use common::{
    pda_seeds, pda_utils, require_active, require_functionality, require_not_paused, require_role,
    roles,
};
use coupon::state::Coupon;
use snapshot::cpi::accounts::GetHolderBalanceSnapshotAt;

use crate::errors::ErrorCode;
use crate::events::CouponPaid;
use crate::state::{CouponPaidMarker, TreasuryConfig};
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};

/// Computes and pays the coupon to a single holder.
///
/// 1. Verifies the authority signature, mint not paused, mint not deactivated.
/// 2. Maturity check: rejects with `CouponNotMature` if the cluster clock
///    hasn't reached `coupon.payment_date` yet.
/// 3. CPIs `snapshot::get_holderbalance_snapshot_at(coupon.snapshot_id)`
///    to read the holder's balance at the coupon's snapshot id (with the
///    snapshot program's own fallback to the live token-account balance).
/// 4. Computes the payout in u128. The mathematical formula is:
///    ```text
///    amount = interest_rate × holder_balance × par_value × elapsed_seconds × 10^payment_mint_dec
///           ─────────────────────────────────────────────────────────────────────────────────────
///           10^interest_dec × 10^bond_mint_dec × 10^par_value_dec × day_count × 86_400
///    ```
///    where `elapsed_seconds = coupon.period_end_date − coupon.period_start_date`
///    — the accrual window of *this* coupon, not the time since bond
///    issuance. Each coupon accrues independently.
///    The `10^bond_mint_dec` divisor converts `holder_balance` (raw mint
///    units) to "number of bonds"; the `10^payment_mint_dec` multiplier
///    converts the resulting dollar amount to raw payment-mint units. All
///    `10^…` factors collapse into a single signed exponent
///    `net_power = payment_dec − (interest_dec + bond_dec + par_value_dec)`,
///    applied as one extra multiplication or division depending on its sign.
///    This keeps intermediate values smaller than the naive form and reduces
///    u128 overflow risk; precision is identical (single end-of-pipeline
///    integer division).
/// 5. CPIs `transfer_checked` via the **token interface** (works for both
///    classic SPL Token and Token-2022 payment mints), signed by
///    `treasury_authority`.
/// 6. Persists `amount` in the freshly-`init`'d `coupon_paid` marker — the
///    `init` constraint is the double-payment guard.
///
/// Account validation handled by Anchor constraints:
/// - `payment_mint.key() == treasury_config.payment_mint` (`address` constraint)
/// - `treasury_token_account.{mint,owner}` match `payment_mint` and
///   `treasury_authority` (`token::mint`, `token::authority`)
/// - `holder_payment_account.mint == payment_mint` (`token::mint`)
/// - All token accounts and the mint share the same `token_program`
///   (`token::token_program` / `mint::token_program`)
pub fn pay_coupon(ctx: Context<PayCoupon>, coupon_id: u64) -> Result<()> {
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

    // ── Maturity check: cluster clock must have reached payment_date ─────────
    let coupon = &ctx.accounts.coupon;
    let now = Clock::get()?.unix_timestamp;
    require!(now >= coupon.payment_date, ErrorCode::CouponNotMature);

    // ── Read holder balance at coupon.snapshot_id via CPI ────────────────────
    let snapshot_id = coupon.snapshot_id;
    let holder_balance: u64 = snapshot::cpi::get_holderbalance_snapshot_at(
        CpiContext::new(
            constants::SNAPSHOT_PROGRAM_ID,
            GetHolderBalanceSnapshotAt {
                mint: ctx.accounts.mint.to_account_info(),
                holder_balance_snapshot: ctx.accounts.holder_balance_snapshot.to_account_info(),
                holder_token_account: ctx.accounts.holder_token_account.to_account_info(),
            },
        ),
        snapshot_id,
    )?
    .get();

    // ── Compute payout amount ────────────────────────────────────────────────
    // The accrual window is encoded on the coupon itself
    // (`period_start_date` … `period_end_date`), set at creation time and
    // validated by `coupon::create_coupon`. Each coupon thus accrues
    // independently rather than cumulatively from the bond's issuance.
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

    // Coupon-level override takes precedence over the asset-level bond_terms rate.
    let (effective_interest_rate, effective_interest_rate_decimals) = match (
        coupon.interest_rate_override,
        coupon.interest_rate_override_decimals,
    ) {
        (Some(rate), Some(dec)) => (rate, dec),
        _ => (bond.interest_rate, bond.interest_rate_decimals),
    };

    // Collapse all four 10^… factors into a single signed exponent.
    // i32 is wide enough: each input is u8, so the sum is bounded by 4·255 = 1020.
    let bond_mint_dec = ctx.accounts.mint.decimals;
    let payment_mint_dec = ctx.accounts.treasury_config.payment_mint_decimals;
    let positive_decs: i32 = effective_interest_rate_decimals as i32
        + bond_mint_dec as i32
        + bond.par_value_decimals as i32;
    let net_power: i32 = payment_mint_dec as i32 - positive_decs;

    // Base numerator: interest_rate × holder_balance × par_value × elapsed_seconds.
    let mut num: u128 = (effective_interest_rate as u128)
        .checked_mul(holder_balance as u128)
        .and_then(|v| v.checked_mul(bond.par_value as u128))
        .and_then(|v| v.checked_mul(elapsed_seconds as u128))
        .ok_or(ErrorCode::AmountOverflow)?;

    // Base denominator: day_count × 86_400.
    let mut den: u128 = (day_count_days as u128)
        .checked_mul(SECONDS_PER_DAY as u128)
        .ok_or(ErrorCode::AmountOverflow)?;

    // Apply the net 10^… factor on whichever side keeps both sides smaller.
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

    // Single end-of-pipeline integer division → maximum precision.
    let amount: u64 = (num / den)
        .try_into()
        .map_err(|_| ErrorCode::AmountOverflow)?;

    // ── transfer_checked via the token interface, signed by treasury_authority ─
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
    // Prevents set_payment_token from changing the payment mint mid-distribution.
    // Idempotent: subsequent pay_coupon calls for the same coupon overwrite the
    // same value.
    ctx.accounts.treasury_config.locked_for_coupon_id = coupon_id;

    // ── Mark this (coupon, holder_token_account) as paid ─────────────────────
    let marker = &mut ctx.accounts.coupon_paid;
    marker.bump = ctx.bumps.coupon_paid;
    marker.amount = amount;

    // ── Emit CouponPaid ──────────────────────────────────────────────────────
    // Emitted last so it only fires when the full payment succeeds.
    emit_cpi!(CouponPaid {
        mint: mint_key,
        coupon_id,
        holder_token_account: ctx.accounts.holder_token_account.key(),
        payment_mint: ctx.accounts.payment_mint.key(),
        amount,
        payer: ctx.accounts.payer.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(coupon_id: u64)]
pub struct PayCoupon<'info> {
    /// Funds rent for the `coupon_paid` marker PDA.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Authority with the necessary roles to authorise the payment.
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

    /// The bond's Token-2022 mint — must not be paused. Loaded as
    /// `InterfaceAccount<Mint>` so we can read `decimals` directly for the
    /// payout math; pause-extension state is still parsed independently by
    /// `require_not_paused` from the same account data.
    ///
    /// Boxed (here and below for the other Mint / TokenAccount / Account
    /// fields) because PayCoupon would otherwise blow the 4 KiB BPF stack
    /// frame during account validation. Only an 8-byte pointer sits on the
    /// stack; the deserialised payload lives on the heap.
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Treasury config storing the payment mint pubkey + decimals.
    /// Seeds: `["treasury_config", mint]`.
    #[account(
        mut,
        seeds = [pda_seeds::TREASURY_CONFIG, mint.key().as_ref()],
        bump = treasury_config.bump,
    )]
    pub treasury_config: Box<Account<'info, TreasuryConfig>>,

    /// Owner of the treasury's payment-mint token account; signs the transfer
    /// via `invoke_signed`.
    /// Seeds: `["treasury_authority", mint]`.
    ///
    /// CHECK: PDA address verified by seeds/bump; signs via invoke_signed.
    #[account(
        seeds = [pda_seeds::TREASURY_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub treasury_authority: UncheckedAccount<'info>,

    /// The payment mint. Must match the one cached in `treasury_config`. May
    /// be owned by either classic SPL Token or Token-2022 — Anchor enforces
    /// it matches `token_program`.
    #[account(
        address = treasury_config.payment_mint,
        mint::token_program = token_program,
    )]
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Treasury's payment-mint token account, owned by `treasury_authority`.
    /// Source of the transfer.
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = treasury_authority,
        token::token_program = token_program,
    )]
    pub treasury_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Destination payment-mint token account. Mint and token program checked
    /// by Anchor; ownership intentionally not enforced
    #[account(
        mut,
        token::mint = payment_mint,
        token::token_program = token_program,
    )]
    pub holder_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The holder's bond-mint token account — used as a seed for the snapshot
    /// PDA + the `coupon_paid` marker, and forwarded to the snapshot CPI for
    /// the live-balance fallback.
    ///
    /// CHECK: Forwarded to snapshot's get_holderbalance_snapshot_at.
    pub holder_token_account: UncheckedAccount<'info>,

    /// Per-mint bond terms — read for interest_rate / par_value / issuance_date / day_count.
    /// Seeds: `["bond_terms", mint]`, owned by bond.
    #[account(
        seeds = [pda_seeds::BOND_TERMS, mint.key().as_ref()],
        seeds::program = constants::BOND_PROGRAM_ID,
        bump = bond_terms.bump,
    )]
    pub bond_terms: Box<Account<'info, BondTerms>>,

    /// The coupon record — read for snapshot_id + payment_date.
    /// Seeds: `["coupon", mint, coupon_id.to_le_bytes()]`, owned by coupon.
    #[account(
        seeds = [pda_seeds::COUPON, mint.key().as_ref(), &coupon_id.to_le_bytes()],
        seeds::program = constants::COUPON_PROGRAM_ID,
        bump = coupon.bump,
    )]
    pub coupon: Box<Account<'info, Coupon>>,

    /// Holder balance snapshot history for `(mint, holder_token_account)`.
    /// Forwarded to snapshot's `get_holderbalance_snapshot_at` CPI; that
    /// instruction handles the empty-history fallback to the live balance.
    /// Seeds: `["snapshot_holderbalance", mint, holder_token_account]`,
    /// owned by snapshot.
    ///
    /// CHECK: Address verified by seeds/bump; contents validated by snapshot CPI.
    #[account(
        seeds = [pda_seeds::SNAPSHOT_HOLDERBALANCE, mint.key().as_ref(), holder_token_account.key().as_ref()],
        seeds::program = constants::SNAPSHOT_PROGRAM_ID,
        bump,
    )]
    pub holder_balance_snapshot: UncheckedAccount<'info>,

    /// Marker PDA — `init` ensures the same `(coupon_id, holder_token_account)`
    /// can't be paid twice (the second attempt fails to create the account).
    /// Seeds: `["coupon_paid", mint, coupon_id.to_le_bytes(), holder_token_account]`.
    #[account(
        init,
        payer = payer,
        space = CouponPaidMarker::DISCRIMINATOR.len() + CouponPaidMarker::INIT_SPACE,
        seeds = [
            pda_seeds::COUPON_PAID,
            mint.key().as_ref(),
            &coupon_id.to_le_bytes(),
            holder_token_account.key().as_ref(),
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

    /// Either `spl-token` or `spl-token-2022`. Anchor's `Interface` accepts
    /// both. The mint and both token accounts must be owned by this program.
    pub token_program: Interface<'info, TokenInterface>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::SNAPSHOT_PROGRAM_ID)]
    pub snapshot_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,
}
