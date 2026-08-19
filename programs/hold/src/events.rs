use anchor_lang::prelude::*;

#[event]
pub struct HoldCreated {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub hold_id: u64,
    pub escrow: Pubkey,
    pub destination: Option<Pubkey>,
    pub amount: u64,
    pub expiration: i64,
}

#[event]
pub struct ControllerHoldCreated {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub hold_id: u64,
    pub controller: Pubkey,
    pub escrow: Pubkey,
    pub destination: Option<Pubkey>,
    pub amount: u64,
    pub expiration: i64,
}

#[event]
pub struct HoldExecuted {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub hold_id: u64,
    pub escrow: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub remaining_amount: u64,
}

#[event]
pub struct HoldReleased {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub hold_id: u64,
    pub escrow: Pubkey,
    pub amount: u64,
    pub remaining_amount: u64,
}

#[event]
pub struct HoldReclaimed {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub hold_id: u64,
    pub caller: Pubkey,
    pub amount: u64,
}
