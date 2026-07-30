use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

/// `mint` is stored first (right after the 8-byte discriminator) so
/// `getProgramAccounts` + `memcmp(offset = 8, mint)` can enumerate every
/// document belonging to a mint off-chain — see `docs/document.md`.
#[account]
#[derive(Debug)]
pub struct Document {
    pub mint: Pubkey,
    pub name: [u8; 32],
    pub uri: String,
    pub document_hash: [u8; 32],
    pub bump: u8,
}

impl Document {
    /// mint(32) + name(32) + document_hash(32) + bump(1).
    const FIXED_SPACE: usize = 32 + 32 + 32 + 1;

    /// Exact on-chain size for a document whose `uri` is `uri_len` *bytes*
    /// long — there is no fixed budget, see `docs/document.md`.
    pub fn space(uri_len: usize) -> usize {
        Self::DISCRIMINATOR.len() + Self::FIXED_SPACE + 4 + uri_len
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_accounts_for_empty_uri() {
        // 8 (discriminator) + 32 (mint) + 32 (name) + 32 (document_hash)
        // + 1 (bump) + 4 (uri Borsh length prefix) + 0 (uri bytes).
        assert_eq!(Document::space(0), 109);
    }

    #[test]
    fn space_accounts_for_one_byte_uri() {
        assert_eq!(Document::space(1), 110);
    }

    #[test]
    fn space_accounts_for_multi_byte_utf8_uri() {
        // "café" is 4 *characters* but 5 *bytes* in UTF-8 (é is 2 bytes) —
        // `space` must be given the byte length, not the character count.
        let uri = "café";
        assert_eq!(uri.chars().count(), 4);
        assert_eq!(uri.len(), 5);
        assert_eq!(Document::space(uri.len()), 114);
    }
}
