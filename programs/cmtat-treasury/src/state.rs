use anchor_lang::prelude::*;

/// Per-mint treasury config: stores the Token-2022 mint used to settle coupon
/// payments (the *payment mint*, e.g. a stablecoin), distinct from the bond
/// mint the rest of the workspace targets. Cached `payment_mint_decimals`
/// avoids re-parsing the mint on every `pay_coupon`. Token-2022 mint decimals
/// are immutable, but if the deployer points the treasury at a different
/// payment mint, the cached value is overwritten by `set_payment_token`.
///
/// Seeds: `["treasury_config", mint]`.
#[account]
pub struct TreasuryConfig {
    pub bump: u8,
    pub payment_mint: Pubkey,
    pub payment_mint_decimals: u8,
}

impl TreasuryConfig {
    // 8 (discriminator) + 1 (bump) + 32 (payment_mint) + 1 (decimals)
    pub const LEN: usize = 8 + 1 + 32 + 1;
}

/// Marker created by `pay_coupon` once a `(coupon_id, holder_token_account)`
/// pair has been paid. Re-creating it on a second call fails because of `init`
/// — that's the double-payment guard.
///
/// Seeds: `["coupon_paid", mint, coupon_id.to_le_bytes(), holder_token_account]`.
#[account]
pub struct CouponPaidMarker {
    pub bump: u8,
    pub amount: u64,
}

impl CouponPaidMarker {
    // 8 (discriminator) + 1 (bump) + 8 (amount)
    pub const LEN: usize = 8 + 1 + 8;
}
