use anchor_lang::prelude::*;

#[event]
pub struct Deactivated {
    pub mint: Pubkey,
    pub operator: Pubkey,
}
