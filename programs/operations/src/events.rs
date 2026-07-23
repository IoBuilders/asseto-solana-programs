use anchor_lang::prelude::*;

#[event]
pub struct ControllerRedemption {
    pub mint: Pubkey,
    pub controller: Pubkey,
    pub from: Pubkey,
    pub value: u64,
}
