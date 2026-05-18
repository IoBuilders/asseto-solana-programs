use anchor_lang::prelude::*;

pub mod errors;
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
    ///
    /// Management instruction — gated by `verify_deployer`, `require_not_paused`,
    /// and `require_active`. The CPI'd `take_snapshot` itself runs no extra
    /// checks; this is the sole entry point that triggers a snapshot.
    pub fn create_coupon(
        ctx: Context<CreateCoupon>,
        period_start_date: i64,
        period_end_date: i64,
        payment_date: i64,
        coupon_id: u64,
    ) -> Result<()> {
        create_coupon::create_coupon(
            ctx,
            period_start_date,
            period_end_date,
            payment_date,
            coupon_id,
        )
    }
}
