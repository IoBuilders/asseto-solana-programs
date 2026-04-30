use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;

use instructions::*;

declare_id!("BANmGRnoLxXCTzKm2aM1Zww8qn7GN2KBkbyY7QpW3vcX");

#[program]
pub mod cmtat_operations {
    use super::*;

    /// Burns tokens from any token account.
    /// Management instruction — called by the deployer.
    pub fn burn(ctx: Context<BurnTokens>, amount: u64) -> Result<()> {
        instructions::burn_tokens::burn(ctx, amount)
    }
}
