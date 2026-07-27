use anchor_lang::prelude::*;

#[event]
pub struct ControllerRedemption {
    pub mint: Pubkey,
    pub controller: Pubkey,
    pub from: Pubkey,
    pub value: u64,
}

#[event]
pub struct ControllerTransferred {
    pub mint: Pubkey,
    pub controller: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    pub value: u64,
}
