use anchor_lang::prelude::*;

#[event]
pub struct CouponPaid {
    pub mint: Pubkey,
    pub coupon_id: u64,
    pub holder: Pubkey,
    pub destination: Pubkey,
    pub balance: u64,
    pub payment_mint: Pubkey,
    pub amount: u64,
    pub payer: Pubkey,
}

#[event]
pub struct PaymentTokenSet {
    pub mint: Pubkey,
    pub payment_mint: Pubkey,
}
