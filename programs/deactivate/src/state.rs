use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct DeactivateStatus {
    pub bump: u8,
}
