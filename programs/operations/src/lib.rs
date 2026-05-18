use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;

use instructions::*;

declare_id!("BHDyg8PeUyVBpmkcjYLdnt3VCmYf4wp8Xeu6TXREiLKp");

#[program]
pub mod operations {
    use super::*;

    /// Burns tokens from any token account.
    /// Management instruction — called by the deployer.
    pub fn burn(ctx: Context<BurnTokens>, amount: u64) -> Result<()> {
        burn_tokens::burn(ctx, amount)
    }
}
