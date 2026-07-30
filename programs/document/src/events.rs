use anchor_lang::prelude::*;

#[event]
pub struct DocumentUpdated {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub name: [u8; 32],
    pub uri: String,
    pub document_hash: [u8; 32],
}

#[event]
pub struct DocumentRemoved {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub name: [u8; 32],
    pub uri: String,
    pub document_hash: [u8; 32],
}
