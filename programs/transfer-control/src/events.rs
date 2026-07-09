use anchor_lang::prelude::*;

use crate::state::TransferMode;

#[event]
pub struct TransferControlModesSet {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub modes: Vec<TransferMode>,
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
