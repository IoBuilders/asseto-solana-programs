use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;

use instructions::*;

declare_id!("Fa5VLqopKp6cokXJreYeNNmUG8F9AaE4CUBnGQvtdq7Q");

#[program]
pub mod transfer {
    use super::*;

    pub fn batch_transfer<'info>(
        ctx: Context<'info, BatchTransferTokens<'info>>,
        amounts: Vec<u64>,
    ) -> Result<()> {
        batch_transfer::batch_transfer(ctx, amounts)
    }
}
