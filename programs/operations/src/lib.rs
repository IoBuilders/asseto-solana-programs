use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;

use instructions::*;

declare_id!("BANmGRnoLxXCTzKm2aM1Zww8qn7GN2KBkbyY7QpW3vcX");

#[program]
pub mod operations {
    use super::*;

    /// Burns tokens from any token account.
    /// Management instruction — called by the deployer.
    pub fn burn(ctx: Context<BurnTokens>, amount: u64) -> Result<()> {
        burn_tokens::burn(ctx, amount)
    }
}
