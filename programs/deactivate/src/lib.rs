use anchor_lang::prelude::*;

pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("H2iRjVVKsKQMAnJKqiTfW2LGvT1G9tDqQ81DzRjxfX7V");

#[program]
pub mod deactivate {
    use super::*;

    pub fn deactivate(ctx: Context<Deactivate>) -> Result<()> {
        instructions::deactivate::deactivate(ctx)
    }
}
