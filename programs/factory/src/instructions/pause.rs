use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_manager};
use crate::state::Factory;

/// Pauses the factory, setting `factory.pause` to `true`.
///
/// Management instruction — only the current `factory.manager` may call this, and
/// only while the factory is not already paused.
pub fn pause(ctx: Context<Pause>) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_manager(&ctx.accounts.factory, &ctx.accounts.manager.key())?;

    ctx.accounts.factory.pause = true;

    Ok(())
}

#[derive(Accounts)]
pub struct Pause<'info> {
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
