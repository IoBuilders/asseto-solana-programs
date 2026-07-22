use anchor_lang::prelude::*;

/// Per-mint treasury config: stores the Token-2022 mint used to settle coupon
/// payments (the *payment mint*, e.g. a stablecoin), distinct from the bond
/// mint the rest of the workspace targets. Cached `payment_mint_decimals`
/// avoids re-parsing the mint on every `pay_coupon`. Token-2022 mint decimals
/// are immutable, but if the treasury is pointed at a different
/// payment mint, the cached value is overwritten by `set_payment_token`.
///
/// `locked_for_coupon_id` is 0 while no claims have been made. The first
/// `pay_coupon` call for a coupon sets it to that coupon's id. Once set,
/// `set_payment_token` is blocked until a new coupon is created (advancing
/// `coupon_counter.count` past `locked_for_coupon_id`).
///
/// Seeds: `["treasury_config", mint]`.
#[account]
#[derive(InitSpace)]
pub struct TreasuryConfig {
    pub bump: u8,
    pub payment_mint: Pubkey,
    pub payment_mint_decimals: u8,
    pub locked_for_coupon_id: u64,
}

/// Marker created by `pay_coupon` once a `(coupon_id, holder_token_account)`
/// pair has been paid. Re-creating it on a second call fails because of `init`
/// — that's the double-payment guard.
///
/// Seeds: `["coupon_paid", mint, coupon_id.to_le_bytes(), holder_token_account]`.
#[account]
#[derive(InitSpace)]
pub struct CouponPaidMarker {
    pub bump: u8,
    pub amount: u64,
}
