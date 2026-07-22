use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_manager};
use crate::state::{Factory, FactoryPendingManager};

pub fn nominate_manager(ctx: Context<NominateManager>, new_manager: Pubkey) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_manager(&ctx.accounts.factory, &ctx.accounts.current_manager.key())?;

    let pending = &mut ctx.accounts.factory_pending_manager_pda;
    pending.pending_manager = new_manager;
    pending.bump = ctx.bumps.factory_pending_manager_pda;

    Ok(())
}

#[derive(Accounts)]
pub struct NominateManager<'info> {
    #[account(mut)]
    pub current_manager: Signer<'info>,

    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    #[account(
        init_if_needed,
        payer = current_manager,
        space = FactoryPendingManager::DISCRIMINATOR.len() + FactoryPendingManager::INIT_SPACE,
        seeds = [pda_seeds::FACTORY_PENDING_MANAGER],
        bump,
    )]
    pub factory_pending_manager_pda: Account<'info, FactoryPendingManager>,

    pub system_program: Program<'info, System>,
}
