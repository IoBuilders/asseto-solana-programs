use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;

use instructions::*;

declare_id!("BHDyg8PeUyVBpmkcjYLdnt3VCmYf4wp8Xeu6TXREiLKp");

#[program]
pub mod operations {
    use super::*;

    pub fn burn<'info>(ctx: Context<'info, BurnTokens<'info>>, amount: u64) -> Result<()> {
        burn_tokens::burn(ctx, amount)
    }

    pub fn batch_burn<'info>(
        ctx: Context<'info, BatchBurnTokens<'info>>,
        amounts: Vec<u64>,
    ) -> Result<()> {
        batch_burn::batch_burn(ctx, amounts)
    }

    pub fn controller_transfer<'info>(
        ctx: Context<'info, ControllerTransfer<'info>>,
        amount: u64,
    ) -> Result<()> {
        controller_transfer::controller_transfer(ctx, amount)
    }

    pub fn hold_transfer(ctx: Context<HoldTransfer>, amount: u64) -> Result<()> {
        hold_transfer::hold_transfer(ctx, amount)
    }
}
