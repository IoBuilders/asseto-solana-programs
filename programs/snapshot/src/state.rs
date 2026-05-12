use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

#[account]
pub struct SnapshotCounter {
    pub bump: u8,
    pub count: u64,
}

impl SnapshotCounter {
    pub const LEN: usize = 8 + 1 + 8; // discriminator + bump + count
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SnapshotEntry {
    pub key: u64,
    pub value: u64,
}

impl SnapshotEntry {
    pub const LEN: usize = 8 + 8;
}

#[account]
pub struct SnapshotHistory {
    pub bump: u8,
    pub entries: Vec<SnapshotEntry>,
}

impl SnapshotHistory {
    pub const BASE_LEN: usize = 8 + 1 + 4; // discriminator + bump + vec length prefix

    pub fn len_for(n_entries: usize) -> usize {
        Self::BASE_LEN + n_entries * SnapshotEntry::LEN
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
