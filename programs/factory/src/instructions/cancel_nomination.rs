use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_manager};
use crate::state::{Factory, FactoryPendingManager};

pub fn cancel_nomination(ctx: Context<CancelNomination>) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_manager(&ctx.accounts.factory, &ctx.accounts.current_manager.key())?;

    Ok(())
}

#[derive(Accounts)]
pub struct CancelNomination<'info> {
    #[account(mut)]
    pub current_manager: Signer<'info>,

    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    #[account(
        mut,
        close = current_manager,
        seeds = [pda_seeds::FACTORY_PENDING_MANAGER],
        bump = factory_pending_manager_pda.bump,
    )]
    pub factory_pending_manager_pda: Account<'info, FactoryPendingManager>,
}
