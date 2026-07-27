use anchor_lang::prelude::*;

#[event]
pub struct MaxSupplySet {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub max_supply: u64,
}
