use anchor_lang::prelude::*;

#[event]
pub struct AccountFrozen {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub operator: Pubkey,
}

#[event]
pub struct AccountUnfrozen {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub operator: Pubkey,
}

#[event]
pub struct AccountPartiallyFrozen {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub frozen_balance: u64,
    pub operator: Pubkey,
}

#[event]
pub struct AccountPartialFreezeRemoved {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub operator: Pubkey,
}
