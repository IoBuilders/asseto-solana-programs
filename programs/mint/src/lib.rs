use anchor_lang::prelude::*;

pub mod events;
pub mod instructions;

use instructions::*;

declare_id!("BgVv7zYbf3L4ECwaeNoNqD6unKWvQtgTwRJ2Dma7iSHQ");

#[program]
pub mod mint {
    use super::*;

    /// Mints `amount` tokens to `destination` for the given Token-2022 mint.
    /// Only the deployer recorded in `mint_owner_pda` may call this instruction.
    pub fn mint(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
        instructions::mint::mint(ctx, amount)
    }
}
