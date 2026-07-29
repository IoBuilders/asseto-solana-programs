use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;

use instructions::*;

declare_id!("Fa5VLqopKp6cokXJreYeNNmUG8F9AaE4CUBnGQvtdq7Q");

#[program]
pub mod transfer {
    use super::*;

    pub fn verify_transfer(ctx: Context<VerifyTransfer>, amount: u64) -> Result<()> {
        verify_transfer::verify_transfer(ctx, amount)
    }

    pub fn batch_transfer<'info>(
        ctx: Context<'info, BatchTransferTokens<'info>>,
        amounts: Vec<u64>,
    ) -> Result<()> {
        batch_transfer::batch_transfer(ctx, amounts)
    }

    pub fn batch_verify_transfer<'info>(
        ctx: Context<'info, BatchVerifyTransfer<'info>>,
        amounts: Vec<u64>,
    ) -> Result<()> {
        batch_verify_transfer::batch_verify_transfer(ctx, amounts)
    }
}
