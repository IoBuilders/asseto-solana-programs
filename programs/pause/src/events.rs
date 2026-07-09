use anchor_lang::prelude::*;

#[event]
pub struct Paused {
    pub mint: Pubkey,
    pub operator: Pubkey,
}

#[event]
pub struct Unpaused {
    pub mint: Pubkey,
    pub operator: Pubkey,
}
