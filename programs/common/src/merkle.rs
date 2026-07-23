use anchor_lang::prelude::Pubkey;
use solana_keccak_hasher as keccak;

pub struct LeafData {
    pub account: Pubkey,
    pub amount: u64,
}

impl LeafData {
    pub fn hash(&self) -> [u8; 32] {
        leaf_hash(&self.account, self.amount)
    }
}

// SECURITY: leaf preimages are fixed at 40 bytes (32-byte Pubkey + 8-byte u64).
// They must never use the same 64-byte encoding as internal nodes,
// which hash the concatenation of two 32-byte child hashes.
pub fn leaf_hash(account: &Pubkey, balance: u64) -> [u8; 32] {
    keccak::hashv(&[account.as_ref(), &balance.to_le_bytes()]).to_bytes()
}

pub fn verify_balance_proof(
    proof: &[[u8; 32]],
    root: [u8; 32],
    account: Pubkey,
    balance: u64,
) -> bool {
    let mut computed = leaf_hash(&account, balance);
    for sibling in proof {
        computed = if computed <= *sibling {
            keccak::hashv(&[&computed, sibling]).to_bytes()
        } else {
            keccak::hashv(&[sibling, &computed]).to_bytes()
        };
    }
    computed == root
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
        if a <= b {
            keccak::hashv(&[&a, &b]).to_bytes()
        } else {
            keccak::hashv(&[&b, &a]).to_bytes()
        }
    }

    fn pk(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    #[test]
    fn single_leaf_tree_root_is_the_leaf() {
        let account = pk(1);
        let balance = 1500u64;
        let root = leaf_hash(&account, balance);

        assert!(verify_balance_proof(&[], root, account, balance));
        assert!(!verify_balance_proof(&[], root, account, balance + 1));
        assert!(!verify_balance_proof(&[], root, pk(2), balance));
    }

    #[test]
    fn two_leaf_proof() {
        let (a0, b0) = (pk(10), 100u64);
        let (a1, b1) = (pk(20), 200u64);
        let l0 = leaf_hash(&a0, b0);
        let l1 = leaf_hash(&a1, b1);
        let root = parent(l0, l1);

        assert!(verify_balance_proof(&[l1], root, a0, b0));
        assert!(verify_balance_proof(&[l0], root, a1, b1));
        assert!(!verify_balance_proof(&[l0], root, a0, b0));
    }

    #[test]
    fn four_leaf_proof() {
        let leaves: [(Pubkey, u64); 4] = [(pk(1), 1), (pk(2), 2), (pk(3), 3), (pk(4), 4)];
        let h: Vec<[u8; 32]> = leaves.iter().map(|(a, b)| leaf_hash(a, *b)).collect();
        let n01 = parent(h[0], h[1]);
        let n23 = parent(h[2], h[3]);
        let root = parent(n01, n23);

        assert!(verify_balance_proof(
            &[h[1], n23],
            root,
            leaves[0].0,
            leaves[0].1
        ));
        assert!(verify_balance_proof(
            &[h[3], n01],
            root,
            leaves[2].0,
            leaves[2].1
        ));

        assert!(!verify_balance_proof(&[h[1], n23], root, leaves[0].0, 999));
        assert!(!verify_balance_proof(
            &[h[1], n23],
            [0u8; 32],
            leaves[0].0,
            leaves[0].1
        ));
        assert!(!verify_balance_proof(&[h[1], n23], root, pk(99), 1));
    }

    #[test]
    fn leaf_data_hash_matches_leaf_hash() {
        let leaf = LeafData {
            account: pk(7),
            amount: 42,
        };
        assert_eq!(leaf.hash(), leaf_hash(&pk(7), 42));
    }
}
