use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, InitSpace)]
pub enum TransferMode {
    Whitelist,
    Blacklist,
}

#[account]
#[derive(InitSpace)]
pub struct TransferControlMode {
    pub mode: TransferMode,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ControlListStatus {
    pub bump: u8,
}
