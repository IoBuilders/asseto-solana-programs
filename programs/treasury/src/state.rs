use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct TreasuryConfig {
    pub bump: u8,
    pub payment_mint: Pubkey,
    pub payment_mint_decimals: u8,
    pub locked_for_coupon_id: u64,
}

#[account]
#[derive(InitSpace)]
pub struct CouponPaidMarker {
    pub bump: u8,
    pub amount: u64,
}
