use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct CouponCounter {
    pub bump: u8,
    pub count: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Coupon {
    pub bump: u8,
    pub snapshot_id: u64,
    pub period_start_date: i64,
    pub period_end_date: i64,
    pub payment_date: i64,
    pub interest_rate_override: Option<u64>,
    pub interest_rate_override_decimals: Option<u8>,
}

impl Coupon {
    pub fn set_interest_rate(&mut self, rate: Option<u64>, decimals: Option<u8>) -> Result<()> {
        require!(
            rate.is_some() == decimals.is_some(),
            crate::errors::ErrorCode::InconsistentRateOverride
        );
        self.interest_rate_override = rate;
        self.interest_rate_override_decimals = decimals;
        Ok(())
    }
}
