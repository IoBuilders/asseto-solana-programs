use anchor_lang::prelude::*;

#[event]
pub struct SnapshotTriggered {
    pub mint: Pubkey,
    pub snapshot_id: u64,
}
