use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_manager};
use crate::state::{Factory, FactoryPendingManager};

/// Cancels a pending manager nomination.
///
/// The `factory_pending_manager_pda` is closed (rent returned to the current
/// manager); `factory.manager` is left unchanged.
///
/// Management instruction — only the current `factory.manager` may call this, and
/// only while the factory is not paused.
pub fn cancel_nomination(ctx: Context<CancelNomination>) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_manager(&ctx.accounts.factory, &ctx.accounts.current_manager.key())?;

    Ok(())
}

#[derive(Accounts)]
pub struct CancelNomination<'info> {
    /// The current factory manager — must sign; receives the closed PDA's lamports.
    #[account(mut)]
    pub current_manager: Signer<'info>,

    /// Singleton factory config PDA. Seeds: `["factory"]`.
    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    /// Pending-manager PDA — closed here; rent returned to the current manager.
    /// Seeds: `["factory_pending_manager"]`.
    #[account(
        mut,
        close = current_manager,
        seeds = [pda_seeds::FACTORY_PENDING_MANAGER],
        bump = factory_pending_manager_pda.bump,
    )]
    pub factory_pending_manager_pda: Account<'info, FactoryPendingManager>,
}
