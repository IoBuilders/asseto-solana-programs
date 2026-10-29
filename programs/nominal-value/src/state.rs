use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum NominalValuePublishType {
    Unit,
    Total,
}

#[account]
#[derive(Debug, InitSpace)]
pub struct NominalValue {
    pub bump: u8,
    /// ISO 4217 currency code; [0, 0, 0] means unset.
    pub nominal_value_currency: [u8; 3],
    pub nominal_value_publish_type: NominalValuePublishType,
    pub nominal_value_decimals: u8,
    pub nominal_value: u128,
    pub effective_datetime: i64,
}
