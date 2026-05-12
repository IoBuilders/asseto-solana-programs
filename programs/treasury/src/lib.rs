use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("CBxS9txE8qZqZkNXhTaWE42Ur3J3GtYv1ufLfNDNUEct");

#[program]
pub mod treasury {
    use super::*;

    /// Sets (or replaces) the Token-2022 mint used to settle coupon payments.
    ///
    /// On the first call creates `treasury_config` (`init_if_needed`) and
    /// caches `payment_mint`'s decimals; on subsequent calls overwrites both
    /// fields. The payment mint is **not** the bond mint — it's the mint used
    /// to pay interest (e.g. a stablecoin).
    ///
    /// Management instruction — gated by `verify_deployer`, `require_not_paused`,
    /// and `require_active`.
    pub fn set_payment_token(ctx: Context<SetPaymentToken>) -> Result<()> {
        set_payment_token::set_payment_token(ctx)
    }

    /// Pays the coupon `coupon_id` to a single holder.
    ///
    /// Reads the holder's balance recorded at the coupon's snapshot id, then
    /// computes:
    /// `amount = (interest_rate / 10^interest_decimals) × holder_balance ×
    /// (par_value / 10^par_value_decimals) × elapsed_seconds /
    /// (day_count × 86_400)`,
    /// where `elapsed_seconds = coupon.payment_date − bond_terms.issuance_date`
    /// and `day_count` is 360 or 365 per `bond_terms.day_count_convention`.
    ///
    /// Issues a Token-2022 `transfer_checked` of `payment_mint` from the
    /// treasury's token account (owner = `treasury_authority` PDA, signed via
    /// `invoke_signed`) to `holder_payment_account`.
    ///
    /// Creates a `coupon_paid` marker PDA via `init` to prevent the same
    /// `(coupon_id, holder_token_account)` pair from being paid twice.
    ///
    /// Management instruction — gated by `verify_deployer`, `require_not_paused`,
    /// and `require_active`.
    pub fn pay_coupon(ctx: Context<PayCoupon>, coupon_id: u64) -> Result<()> {
        pay_coupon::pay_coupon(ctx, coupon_id)
    }
}
