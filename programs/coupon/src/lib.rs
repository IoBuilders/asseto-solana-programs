use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("CGQMgamBMtJ97CCMwVD9v5vAYVzFsXLy8beN8Ej6t3FK");

#[program]
pub mod coupon {
    use super::*;

    /// Creates a new coupon for the mint.
    ///
    /// Increments `coupon_counter` (init_if_needed on the first call), CPIs into
    /// `snapshot::take_snapshot` signed by the `coupon_authority` PDA, and
    /// records the new coupon at `["coupon", mint, coupon_id.to_le_bytes()]`
    /// with the resulting snapshot id and the supplied payment date.
    ///
    /// `coupon_id` must equal `coupon_counter.count + 1` (or `1` on the first
    /// call) — the client computes it from the current counter, the program
    /// re-checks it before committing.
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
        create_coupon::create_coupon(
            ctx,
            period_start_date,
            period_end_date,
            payment_date,
            coupon_id,
            interest_rate_override,
            interest_rate_override_decimals,
            merkle_root,
        )
    }

    /// Overrides the interest rate for a single already-issued coupon.
    ///
    /// Sets `coupon.interest_rate_override` and
    /// `coupon.interest_rate_override_decimals` so that
    /// `treasury::pay_coupon` uses this rate instead of the asset-level rate
    /// stored in `bond_terms`. Follows the same scaling convention as
    /// `BondTerms`: actual rate = `interest_rate / 10^interest_rate_decimals`.
    ///
    /// Calling this instruction again replaces the previous values.
    pub fn set_coupon_rate(
        ctx: Context<SetCouponRate>,
        coupon_id: u64,
        interest_rate: Option<u64>,
        interest_rate_decimals: Option<u8>,
    ) -> Result<()> {
        set_coupon_rate::set_coupon_rate(ctx, coupon_id, interest_rate, interest_rate_decimals)
    }
}
