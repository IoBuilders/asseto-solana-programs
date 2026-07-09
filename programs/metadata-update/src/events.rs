use anchor_lang::prelude::*;

#[event]
pub struct MetadataFieldUpdated {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub key: String,
    pub value: String,
}

#[event]
pub struct MetadataFieldRemoved {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub key: String,
}
