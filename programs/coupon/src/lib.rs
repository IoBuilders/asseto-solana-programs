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

    pub fn set_coupon_rate(
        ctx: Context<SetCouponRate>,
        coupon_id: u64,
        interest_rate: Option<u64>,
        interest_rate_decimals: Option<u8>,
    ) -> Result<()> {
        set_coupon_rate::set_coupon_rate(ctx, coupon_id, interest_rate, interest_rate_decimals)
    }
}
