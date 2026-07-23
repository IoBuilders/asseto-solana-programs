use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;

use instructions::*;

declare_id!("BHDyg8PeUyVBpmkcjYLdnt3VCmYf4wp8Xeu6TXREiLKp");

#[program]
pub mod operations {
    use super::*;

    pub fn burn(ctx: Context<BurnTokens>, amount: u64) -> Result<()> {
        burn_tokens::burn(ctx, amount)
    }
}
