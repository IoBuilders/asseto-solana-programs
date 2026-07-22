use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_manager};
use crate::state::Factory;

pub fn pause(ctx: Context<Pause>) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_manager(&ctx.accounts.factory, &ctx.accounts.manager.key())?;

    ctx.accounts.factory.pause = true;

    Ok(())
}

#[derive(Accounts)]
pub struct Pause<'info> {
    pub manager: Signer<'info>,

    #[account(
        mut,
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,
}
