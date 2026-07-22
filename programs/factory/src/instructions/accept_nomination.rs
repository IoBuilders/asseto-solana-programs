use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_pending_manager};
use crate::state::{Factory, FactoryPendingManager};

pub fn accept_nomination(ctx: Context<AcceptNomination>) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_pending_manager(
        &ctx.accounts.factory_pending_manager_pda,
        &ctx.accounts.pending_manager.key(),
    )?;

    ctx.accounts.factory.manager = ctx.accounts.factory_pending_manager_pda.pending_manager;

    Ok(())
}

#[derive(Accounts)]
pub struct AcceptNomination<'info> {
    #[account(mut)]
    pub pending_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    #[account(
        mut,
        close = pending_manager,
        seeds = [pda_seeds::FACTORY_PENDING_MANAGER],
        bump = factory_pending_manager_pda.bump,
    )]
    pub factory_pending_manager_pda: Account<'info, FactoryPendingManager>,
}
