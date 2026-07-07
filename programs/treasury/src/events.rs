use anchor_lang::prelude::*;

/// Emitted once per successful `pay_coupon`, after the payment has been
/// transferred from the treasury to the holder and the `coupon_paid` marker
/// has been created.
#[event]
pub struct CouponPaid {
    pub mint: Pubkey,
    /// The coupon that was paid.
    pub coupon_id: u64,
    /// The holder's bond-mint token account the payout was computed for.
    pub holder_token_account: Pubkey,
    /// The mint the coupon was settled in.
    pub payment_mint: Pubkey,
    /// Raw payment-mint units transferred to the holder.
    pub amount: u64,
    /// The account that funded the payment transaction.
    pub payer: Pubkey,
}

/// Emitted once per successful `set_payment_token`, after `treasury_config` has
/// cached the mint used to settle coupon payments.
#[event]
pub struct PaymentTokenSet {
    pub mint: Pubkey,
    /// The mint now configured for coupon payouts.
    pub payment_mint: Pubkey,
}
