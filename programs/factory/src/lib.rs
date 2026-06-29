use anchor_lang::prelude::*;

pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("FEY9E77nH7R1gLGNxkhYKchJpB6MgpMrWMhkNXrNhzR5");

#[program]
pub mod factory {
    use super::*;

    /// Creates the singleton `factory` PDA, recording the `manager` signer and
    /// defaulting `pause` to `false`. Fails if the PDA already exists.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::initialize(ctx)
    }
}
