use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

/// Per-mint snapshot counter.
///
/// ⚠️ `count` is the id of the **NEXT** snapshot, NOT the current/last one.
/// It is 0-based: created at `count = 0`, so the first snapshot has id `0`, and
/// `count` is incremented **after** each snapshot is taken. Therefore:
///   - number of snapshots taken so far  == `count`
///   - id of the **last-taken** (currently-active) snapshot == `count - 1`
///     (only valid when `count >= 1`; use `count.saturating_sub(1)`)
///   - PDA absent / not yet created       == no snapshot taken yet
#[account]
#[derive(InitSpace)]
pub struct SnapshotCounter {
    pub bump: u8,
    /// Id of the **next** snapshot (0-based). See the struct docs: the
    /// last-taken snapshot id is `count - 1`, never `count`.
    pub count: u64,
}

/// One immutable Merkle-root commitment per snapshot.
///
/// Created by `take_snapshot` at `["snapshot_merkle_root", mint, snapshot_id]`
/// (where `snapshot_id` = `SnapshotCounter.count` at the time). Holds the 32-byte
/// root of the off-chain Sorted-pair Merkle tree whose leaves are
/// `(account, balance)` pairs at that snapshot. Created with Anchor's
/// `#[account(init)]`, so it can be created only once per id — the root is
/// immutable — and Anchor handles a pre-funded PDA address transparently.
#[account]
#[derive(InitSpace)]
pub struct SnapshotMerkleRoot {
    pub bump: u8,
    pub merkle_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct SnapshotEntry {
    pub key: u64,
    pub value: u64,
}

#[account]
#[derive(InitSpace)]
pub struct SnapshotHistory {
    pub bump: u8,
    #[max_len(0)]
    pub entries: Vec<SnapshotEntry>,
}

impl SnapshotHistory {
    pub const BASE_LEN: usize = SnapshotHistory::DISCRIMINATOR.len() + Self::INIT_SPACE;

    pub fn len_for(n_entries: usize) -> usize {
        Self::BASE_LEN + n_entries * SnapshotEntry::INIT_SPACE
    }

    pub fn load(account: &AccountInfo) -> Result<Self> {
        let data = account.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        Self::try_deserialize(&mut slice)
    }

    pub fn store(&self, account: &AccountInfo) -> Result<()> {
        let mut account_data = account.try_borrow_mut_data()?;
        account_data[..8].copy_from_slice(&Self::DISCRIMINATOR);
        let mut cursor = std::io::Cursor::new(&mut account_data[8..]);
        self.serialize(&mut cursor)?;
        Ok(())
    }

    pub fn push_entry(&mut self, entry: SnapshotEntry) -> bool {
        if self.has_entry_for(entry.key) {
            return false;
        }
        self.entries.push(entry);
        true
    }

    fn has_entry_for(&self, key: u64) -> bool {
        self.entries.last().map(|e| e.key) == Some(key)
    }

    pub fn lookup_at_or_above(&self, key: u64) -> Option<u64> {
        match self.entries.binary_search_by_key(&key, |e| e.key) {
            Ok(i) => Some(self.entries[i].value),
            Err(i) => self.entries.get(i).map(|e| e.value),
        }
    }
}
