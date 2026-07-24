use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

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
}
