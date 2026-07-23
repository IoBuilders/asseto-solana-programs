use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct FrozenAccountStatus {
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct FrozenBalance {
    pub balance: u64,
    pub bump: u8,
}
