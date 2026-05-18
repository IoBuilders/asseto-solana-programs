use anchor_lang::prelude::*;

pub mod instructions;

use instructions::*;

declare_id!("BgVv7zYbf3L4ECwaeNoNqD6unKWvQtgTwRJ2Dma7iSHQ");

#[cfg(test)]
mod program_id_sync_tests {
    use common::program_ids::*;

    #[test]
    fn mint_id_in_sync() {
        assert_eq!(MINT_PROGRAM_ID, crate::ID);
    }
    #[test]
    fn freeze_id_in_sync() {
        assert_eq!(FREEZE_PROGRAM_ID, freeze::ID);
    }
    #[test]
    fn snapshot_id_in_sync() {
        assert_eq!(SNAPSHOT_PROGRAM_ID, snapshot::ID);
    }
    #[test]
    fn transfer_control_id_in_sync() {
        assert_eq!(
            TRANSFER_CONTROL_PROGRAM_ID,
            transfer_control::ID
        );
    }
}

#[program]
pub mod mint {
    use super::*;

    /// Mints `amount` tokens to `destination` for the given Token-2022 mint.
    /// Only the deployer recorded in `mint_owner_pda` may call this instruction.
    pub fn mint(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
        instructions::mint::mint(ctx, amount)
    }
}
