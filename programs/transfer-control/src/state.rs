use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, InitSpace)]
pub enum TransferMode {
    Whitelist,
}

#[account]
#[derive(InitSpace)]
pub struct TransferControlMode {
    pub mode: TransferMode,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct WhitelistStatus {
    pub bump: u8,
}
