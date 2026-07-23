use anchor_lang::prelude::*;

#[event]
pub struct SnapshotTriggered {
    pub mint: Pubkey,
    pub snapshot_id: u64,
    pub merkle_root: [u8; 32],
}
