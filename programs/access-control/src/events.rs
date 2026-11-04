use anchor_lang::prelude::*;

#[event]
pub struct RolesGranted {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub operator: Pubkey,
    pub roles: Vec<u16>,
}

#[event]
pub struct RolesRevoked {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub operator: Pubkey,
    pub roles: Vec<u16>,
}
