use anchor_lang::prelude::*;

use crate::state::DayCountConvention;

#[event]
pub struct BondTermsUpdated {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub interest_rate: u64,
    pub interest_rate_decimals: u8,
    pub par_value: u64,
    pub par_value_decimals: u8,
    pub minimum_denomination: u64,
    pub issuance_date: i64,
    pub day_count_convention: DayCountConvention,
}
