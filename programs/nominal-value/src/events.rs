use anchor_lang::prelude::*;

use crate::state::NominalValuePublishType;

#[event]
pub struct NominalValueInitialized {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub nominal_value_decimals: u8,
    pub nominal_value_currency: [u8; 3],
    pub nominal_value_publish_type: NominalValuePublishType,
}

#[event]
pub struct NominalValuePublished {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub nominal_value: u128,
    pub effective_datetime: i64,
}

#[event]
pub struct NominalValueRepublished {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub nominal_value: u128,
    pub effective_datetime: i64,
}
