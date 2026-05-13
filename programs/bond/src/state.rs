use anchor_lang::prelude::*;

/// Day-count convention used to compute accrued interest between two dates.
/// Encoded as a single byte on-chain via Borsh's enum tag.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum DayCountConvention {
    /// Actual days / 360 (money-market convention).
    Actual360,
    /// Actual days / 365.
    Actual365,
}

/// Subset of the bond's term sheet that is exposed on-chain in a typed PDA so
/// other programs can read it directly without scanning Token-2022 metadata.
///
/// Stored once per mint at the PDA `["bond_terms", mint]`.
#[account]
#[derive(Debug, InitSpace)]
pub struct BondTerms {
    /// Bump for the `["bond_terms", mint]` PDA.
    pub bump: u8,
    /// Annual coupon rate, scaled by `10^interest_rate_decimals` and expressed
    /// as a fraction (i.e. actual rate = `interest_rate / 10^interest_rate_decimals`).
    /// Example: 5.275 % is `interest_rate = 5275`, `interest_rate_decimals = 5`.
    pub interest_rate: u64,
    /// Number of fractional digits for `interest_rate`. See `interest_rate`.
    pub interest_rate_decimals: u8,
    /// Face/redemption amount per bond, denominated in the bond's reference
    /// currency (recorded as Token-2022 metadata, not here). Scaled by
    /// `10^par_value_decimals` — e.g. $1,000.00 USD is `par_value = 100_000`,
    /// `par_value_decimals = 2`. Independent of the SPL mint's `decimals`.
    pub par_value: u64,
    /// Number of fractional digits for `par_value`. See `par_value`.
    pub par_value_decimals: u8,
    /// Smallest tradeable bond size, in raw mint units (uses the SPL mint's
    /// `decimals` — no separate decimal field needed).
    pub minimum_denomination: u64,
    /// Bond issuance date as a Unix timestamp (seconds).
    pub issuance_date: i64,
    /// Day-count convention used to compute accrued interest.
    pub day_count_convention: DayCountConvention,
}


/// Args struct passed to `update_bond_terms` — mirrors `BondTerms` minus the
/// `bump` field, which the program manages itself.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BondTermsArgs {
    pub interest_rate: u64,
    pub interest_rate_decimals: u8,
    pub par_value: u64,
    pub par_value_decimals: u8,
    pub minimum_denomination: u64,
    pub issuance_date: i64,
    pub day_count_convention: DayCountConvention,
}
