use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_paused, verify_manager};
use crate::state::Factory;

pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    require_paused(&ctx.accounts.factory)?;
    verify_manager(&ctx.accounts.factory, &ctx.accounts.manager.key())?;

    ctx.accounts.factory.pause = false;

    Ok(())
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    pub manager: Signer<'info>,

    #[account(
        mut,
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,
}
