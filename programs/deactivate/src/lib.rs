use anchor_lang::prelude::*;

pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("H2iRjVVKsKQMAnJKqiTfW2LGvT1G9tDqQ81DzRjxfX7V");

#[program]
pub mod deactivate {
    use super::*;

    /// Deactivates the Token-2022 mint by creating an on-chain marker PDA.
    /// The PDA's existence signals permanent deactivation of the mint.
    pub fn deactivate(ctx: Context<Deactivate>) -> Result<()> {
        instructions::deactivate::deactivate(ctx)
    }
}
