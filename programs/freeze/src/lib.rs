use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
mod registry;

use instructions::*;
declare_id!("8L1kqDvAYC9dQXNNNnZbABtRbHGjzoxSgAPzbQZmwmSd");

#[program]
pub mod freeze {
    use super::*;

    pub fn freeze_account<'info>(ctx: Context<'info, FreezeAccount<'info>>) -> Result<()> {
        freeze_account::freeze_account(ctx)
    }

    pub fn batch_freeze_account<'info>(
        ctx: Context<'info, BatchFreezeAccount<'info>>,
    ) -> Result<()> {
        batch_freeze_account::batch_freeze_account(ctx)
    }

    pub fn unfreeze_account<'info>(ctx: Context<'info, UnfreezeAccount<'info>>) -> Result<()> {
        unfreeze_account::unfreeze_account(ctx)
    }

    pub fn batch_unfreeze_account<'info>(
        ctx: Context<'info, BatchUnfreezeAccount<'info>>,
    ) -> Result<()> {
        batch_unfreeze_account::batch_unfreeze_account(ctx)
    }

    pub fn freeze_account_partial<'info>(
        ctx: Context<'info, FreezeAccountPartial<'info>>,
        balance: u64,
    ) -> Result<()> {
        freeze_account_partial::freeze_account_partial(ctx, balance)
    }

    pub fn batch_freeze_account_partial<'info>(
        ctx: Context<'info, BatchFreezeAccountPartial<'info>>,
        balances: Vec<u64>,
    ) -> Result<()> {
        batch_freeze_account_partial::batch_freeze_account_partial(ctx, balances)
    }

    pub fn unfreeze_account_partial<'info>(
        ctx: Context<'info, UnfreezeAccountPartial<'info>>,
    ) -> Result<()> {
        unfreeze_account_partial::unfreeze_account_partial(ctx)
    }

    pub fn batch_unfreeze_account_partial<'info>(
        ctx: Context<'info, BatchUnfreezeAccountPartial<'info>>,
    ) -> Result<()> {
        batch_unfreeze_account_partial::batch_unfreeze_account_partial(ctx)
    }
}
