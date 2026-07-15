use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_paused, verify_manager};
use crate::state::Factory;

/// Unpauses the factory, setting `factory.pause` to `false`.
///
/// Management instruction — only the current `factory.manager` may call this, and
/// only while the factory is paused.
pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    require_paused(&ctx.accounts.factory)?;
    verify_manager(&ctx.accounts.factory, &ctx.accounts.manager.key())?;

    ctx.accounts.factory.pause = false;

    Ok(())
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    /// The current factory manager — must sign.
    pub manager: Signer<'info>,

    /// Singleton factory config PDA. Seeds: `["factory"]`.
    #[account(
        mut,
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,
}
