use anchor_lang::prelude::*;

#[event]
pub struct Issued {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub to: Pubkey,
    pub value: u64,
}
