use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("G71RRNtr2PLZ9Tbmp9CKnxghf3aMoasUwLGPb2u7BytA");

#[program]
pub mod treasury {
    use super::*;

    pub fn set_payment_token(ctx: Context<SetPaymentToken>) -> Result<()> {
        set_payment_token::set_payment_token(ctx)
    }

    pub fn pay_coupon(
        ctx: Context<PayCoupon>,
        coupon_id: u64,
        account: Pubkey,
        balance: u64,
        merkle_proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        pay_coupon::pay_coupon(ctx, coupon_id, account, balance, merkle_proof)
    }
}
