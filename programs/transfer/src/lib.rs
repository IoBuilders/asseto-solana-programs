use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;

use instructions::*;

declare_id!("Fa5VLqopKp6cokXJreYeNNmUG8F9AaE4CUBnGQvtdq7Q");

#[program]
pub mod transfer {
    use super::*;

    pub fn transfer(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
        transfer_tokens::transfer(ctx, amount)
    }

    pub fn verify_transfer(ctx: Context<VerifyTransfer>, amount: u64) -> Result<()> {
        verify_transfer::verify_transfer(ctx, amount)
    }
}
