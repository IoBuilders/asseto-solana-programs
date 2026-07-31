use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;

use instructions::*;

declare_id!("BgVv7zYbf3L4ECwaeNoNqD6unKWvQtgTwRJ2Dma7iSHQ");

#[program]
pub mod mint {
    use super::*;

    pub fn mint<'info>(ctx: Context<'info, MintTokens<'info>>, amount: u64) -> Result<()> {
        instructions::mint::mint(ctx, amount)
    }

    /// Mints, in a single instruction, `amounts[i]` tokens to the `i`-th destination
    /// for every index `i` of the given Token-2022 mint. Runs the same checks as
    /// `mint` (issuer role, active, functionality, whitelist) but skips snapshots.
    /// Per-destination token accounts and whitelist PDAs are passed via
    /// `remaining_accounts` (two per destination). Only a `ROLE_ISSUER` holder may call it.
    pub fn batch_mint<'info>(
        ctx: Context<'info, BatchMintTokens<'info>>,
        amounts: Vec<u64>,
    ) -> Result<()> {
        batch_mint::batch_mint(ctx, amounts)
    }
}
