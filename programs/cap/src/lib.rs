use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

pub use common::program_ids::*;

declare_id!("64THHYmfoHeWxbZQYq8yRsQJYydfd7yPa6MzNgebiJLm");

#[program]
pub mod cap {
    use super::*;

    pub fn set_max_supply(ctx: Context<SetMaxSupply>, max_supply: u64) -> Result<()> {
        instructions::set_max_supply::set_max_supply(ctx, max_supply)
    }
}
