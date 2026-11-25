use anchor_lang::prelude::*;
use common::state::{TRANSFER_MODE_BLACKLIST, TRANSFER_MODE_WHITELIST};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, InitSpace)]
pub enum TransferMode {
    Whitelist,
    Blacklist,
}

impl TransferMode {
    /// The `MintCompliance.transfer_mode` encoding (0 is reserved for "no mode").
    pub fn compliance_value(self) -> u8 {
        match self {
            TransferMode::Whitelist => TRANSFER_MODE_WHITELIST,
            TransferMode::Blacklist => TRANSFER_MODE_BLACKLIST,
        }
    }
}
