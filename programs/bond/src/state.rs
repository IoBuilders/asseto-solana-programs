use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum DayCountConvention {
    Actual360,
    Actual365,
}

#[account]
#[derive(Debug, InitSpace)]
pub struct BondTerms {
    pub bump: u8,
    pub interest_rate: u64,
    pub interest_rate_decimals: u8,
    pub par_value: u64,
    pub par_value_decimals: u8,
    pub minimum_denomination: u64,
    pub issuance_date: i64,
    pub day_count_convention: DayCountConvention,
}

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
