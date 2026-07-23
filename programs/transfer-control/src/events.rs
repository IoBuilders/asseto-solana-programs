use anchor_lang::prelude::*;

use crate::state::TransferMode;

#[event]
pub struct TransferControlModeSet {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub mode: TransferMode,
}

#[event]
pub struct AccountWhitelisted {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub operator: Pubkey,
}

#[event]
pub struct AccountRemovedFromWhitelist {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub operator: Pubkey,
}
