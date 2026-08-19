use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum HoldStatus {
    Active,
    Expired,
    Closed,
}

#[account]
#[derive(Debug, InitSpace)]
pub struct HoldPosition {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub held_amount: u64,
    /// Count of holds created against this position, never reset. The id
    /// assigned to the next hold is `hold_count + 1`, so the first hold gets
    /// `hold_id == 1` (mirrors `coupon`'s `count + 1` numbering).
    pub hold_count: u64,
    pub bump: u8,
}

// `common::state::HoldPosition` mirrors this struct so other programs can read the
// lien without importing `hold`. Anything that changes the layout or the
// discriminator here must change it there too, or those reads silently misparse.
const _: () = assert!(HoldPosition::INIT_SPACE == common::state::HoldPosition::INIT_SPACE);

#[account]
#[derive(Debug, InitSpace)]
pub struct Hold {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub hold_id: u64,
    pub escrow: Pubkey,
    pub destination: Option<Pubkey>,
    pub initial_amount: u64,
    pub current_amount: u64,
    pub created_at: i64,
    pub expiration: i64,
    pub status: HoldStatus,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AccountDeserialize;

    /// Serializes this crate's `HoldPosition` and reads it back through the
    /// `common` mirror other programs use, so any divergence in discriminator or
    /// field layout fails here instead of silently misparsing a lien on-chain.
    #[test]
    fn mirror_in_common_reads_the_same_layout() {
        let position = HoldPosition {
            mint: Pubkey::new_unique(),
            token_account: Pubkey::new_unique(),
            held_amount: 0x1122_3344_5566_7788,
            hold_count: 0x99AA_BBCC_DDEE_FF00,
            bump: 7,
        };

        let mut data = HoldPosition::DISCRIMINATOR.to_vec();
        position.serialize(&mut data).unwrap();

        let mirrored = common::state::HoldPosition::try_deserialize(&mut data.as_slice()).unwrap();

        assert_eq!(mirrored.mint, position.mint);
        assert_eq!(mirrored.token_account, position.token_account);
        assert_eq!(mirrored.held_amount, position.held_amount);
        assert_eq!(mirrored.hold_count, position.hold_count);
        assert_eq!(mirrored.bump, position.bump);
    }
}
