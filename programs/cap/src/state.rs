use anchor_lang::prelude::*;

#[account]
#[derive(Debug, InitSpace)]
pub struct MaxSupply {
    pub bump: u8,
    pub max_supply: u64,
}
