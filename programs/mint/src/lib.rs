use anchor_lang::prelude::*;

pub mod constants;
pub mod instructions;

use instructions::*;

declare_id!("AXGtgWoPXfyfQ7o823WG2ip6qSRw1s3wA3RCSdtCyN1P");

#[program]
pub mod mint {
    use super::*;

    /// Mints `amount` tokens to `destination` for the given Token-2022 mint.
    /// Only the deployer recorded in `mint_owner_pda` may call this instruction.
    pub fn mint(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
        instructions::mint::mint(ctx, amount)
    }
}
