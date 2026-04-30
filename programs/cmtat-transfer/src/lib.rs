use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;

use instructions::*;

declare_id!("EY3ndaFy8e647firyg1MiyNH9LJkBKfV9VK8CNc4N1MD");

#[program]
pub mod cmtat_transfer {
    use super::*;

    /// Transfers tokens from source to destination.
    /// Operational instruction — called by the token holder who owns the source account.
    pub fn transfer(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
        instructions::transfer_tokens::transfer(ctx, amount)
    }
}
