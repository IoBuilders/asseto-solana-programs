use anchor_lang::prelude::*;

#[account]
pub struct SnapshotCounter {
    pub bump: u8,
    pub count: u64,
}

impl SnapshotCounter {
    pub const LEN: usize = 8 + 1 + 8; // discriminator + bump + count
}

#[account]
pub struct ValueSnapshot {
    pub bump: u8,
    pub value: u64,
}

impl ValueSnapshot {
    pub const LEN: usize = 8 + 1 + 8; // discriminator + bump + supply
}
