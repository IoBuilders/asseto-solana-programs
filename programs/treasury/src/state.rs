use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct TreasuryConfig {
    pub bump: u8,
    pub payment_mint: Pubkey,
    pub payment_mint_decimals: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CouponPaidMarker {
    pub bump: u8,
    pub amount: u64,
}

#[account]
#[derive(InitSpace)]
pub struct CouponDistribution {
    pub bump: u8,
    pub payment_mint: Pubkey,
    pub payment_mint_decimals: u8,
    pub interest_rate: u64,
    pub interest_rate_decimals: u8,
    pub par_value: u64,
    pub par_value_decimals: u8,
    pub day_count_days: u16,
    pub paid_count: u64,
    pub total_paid: u64,
}

impl CouponDistribution {
    pub fn is_open(&self) -> bool {
        self.payment_mint != Pubkey::default()
    }
}
