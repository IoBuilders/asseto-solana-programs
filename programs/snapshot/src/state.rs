use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct SnapshotCounter {
    pub bump: u8,
    /// Id of the **next** snapshot (0-based).
    pub count: u64,
}

#[account]
#[derive(InitSpace)]
pub struct SnapshotMerkleRoot {
    pub bump: u8,
    pub merkle_root: [u8; 32],
}
