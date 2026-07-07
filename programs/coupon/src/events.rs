use anchor_lang::prelude::*;

#[event]
pub struct CouponCreated {
    pub mint: Pubkey,
    pub coupon_id: u64,
    pub period_start_date: i64,
    pub period_end_date: i64,
    pub payment_date: i64,
    pub interest_rate_override: Option<u64>,
    pub interest_rate_override_decimals: Option<u8>,
}

#[event]
pub struct CouponRateSet {
    pub mint: Pubkey,
    pub coupon_id: u64,
    pub interest_rate_override: Option<u64>,
    pub interest_rate_override_decimals: Option<u8>,
}
