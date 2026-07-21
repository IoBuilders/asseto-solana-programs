use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

#[account]
#[derive(InitSpace)]
pub struct SnapshotCounter {
    pub bump: u8,
    pub count: u64,
}

/// One immutable Merkle-root commitment per snapshot.
///
/// Created by `take_snapshot` at `["snapshot_merkle_root", mint, snapshot_id]`.
/// Holds the 32-byte root of the off-chain Sorted-pair Merkle tree whose leaves
/// are `(account, balance)` pairs at that snapshot. The account is created once
/// and never rewritten — the snapshot id is strictly increasing, so its address
/// is never reused, and `take_snapshot` creates it with `create_account` (which
/// fails if the PDA already exists).
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

    /// Borsh-deserializes the history from a populated account.
    pub fn load(account: &AccountInfo) -> Result<Self> {
        let data = account.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        Self::try_deserialize(&mut slice)
    }

    /// Writes the Anchor discriminator followed by the Borsh-serialized payload
    /// into `account`. The account must already be sized to hold the data.
    pub fn store(&self, account: &AccountInfo) -> Result<()> {
        let mut account_data = account.try_borrow_mut_data()?;
        account_data[..8].copy_from_slice(&Self::DISCRIMINATOR);
        let mut cursor = std::io::Cursor::new(&mut account_data[8..]);
        self.serialize(&mut cursor)?;
        Ok(())
    }

    /// Appends `(key, value)`. Returns `false` (no-op) if the last entry already
    /// has this key, enforcing the strictly-increasing-key invariant.
    pub fn push_entry(&mut self, entry: SnapshotEntry) -> bool {
        if self.has_entry_for(entry.key) {
            return false;
        }
        self.entries.push(entry);
        true
    }

    /// Returns `true` if an entry for `key` has already been recorded.
    fn has_entry_for(&self, key: u64) -> bool {
        self.entries.last().map(|e| e.key) == Some(key)
    }

    /// Looks up the value recorded at `key`. If `key` is not present, returns the
    /// value of the entry with the smallest key strictly greater than `key`.
    /// Returns `None` if the history is empty or every recorded key is smaller
    /// than `key`. Relies on the strictly-increasing-key invariant maintained by
    /// the update instructions.
    pub fn lookup_at_or_above(&self, key: u64) -> Option<u64> {
        match self.entries.binary_search_by_key(&key, |e| e.key) {
            Ok(i) => Some(self.entries[i].value),
            Err(i) => self.entries.get(i).map(|e| e.value),
        }
    }
}
