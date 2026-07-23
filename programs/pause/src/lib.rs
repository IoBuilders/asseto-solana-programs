use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;

use instructions::*;

declare_id!("5j3F89fmVVusjwy9z3Rv5wLaVj4ovhwctQ7TRBsxNghq");

#[program]
pub mod pause {
    use super::*;

    pub fn pause(ctx: Context<PauseMint>) -> Result<()> {
        pause_mint::pause(ctx)
    }

    pub fn unpause(ctx: Context<UnpauseMint>) -> Result<()> {
        unpause_mint::unpause(ctx)
    }
}
