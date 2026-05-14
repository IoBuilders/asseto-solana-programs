use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;

use instructions::*;

declare_id!("EY3ndaFy8e647firyg1MiyNH9LJkBKfV9VK8CNc4N1MD");

#[program]
pub mod transfer {
    use super::*;

    /// Transfers tokens from source to destination.
    /// Operational instruction — called by the token holder who owns the source account.
    pub fn transfer(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
        transfer_tokens::transfer(ctx, amount)
    }

    /// Pre-transfer compliance check.
    ///
    /// Runs all pre-transfer rules (deactivation, transfer-control mode,
    /// whitelist, frozen account, frozen balance) without moving any tokens.
    /// Intended to be invoked as the immediately-prior top-level instruction
    /// before `transfer` in the same transaction; the transfer hook introspects
    /// the `Instructions` sysvar to verify both calls are present, adjacent,
    /// and refer to the same source / destination / mint / amount.
    pub fn verify_transfer(ctx: Context<VerifyTransfer>, amount: u64) -> Result<()> {
        verify_transfer::verify_transfer(ctx, amount)
    }
}
