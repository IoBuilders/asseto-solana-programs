use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_pending_manager};
use crate::state::{Factory, FactoryPendingManager};

/// Accepts a pending manager nomination, promoting the pending manager to manager.
///
/// The recorded `pending_manager` becomes the new `factory.manager`, and the
/// `factory_pending_manager_pda` is closed (rent returned to the new manager).
///
/// Operational instruction — only the recorded `pending_manager` may call this, and
/// only while the factory is not paused.
pub fn accept_nomination(ctx: Context<AcceptNomination>) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_pending_manager(
        &ctx.accounts.factory_pending_manager_pda,
        &ctx.accounts.pending_manager.key(),
    )?;

    // ── Promote the pending manager to manager ────────────────────────────────
    ctx.accounts.factory.manager = ctx.accounts.factory_pending_manager_pda.pending_manager;

    Ok(())
}

#[derive(Accounts)]
pub struct AcceptNomination<'info> {
    /// The pending manager accepting the nomination — must sign; receives the
    /// closed PDA's lamports.
    #[account(mut)]
    pub pending_manager: Signer<'info>,

    /// Singleton factory config PDA. Seeds: `["factory"]`. `manager` is updated here.
    #[account(
        mut,
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    /// Pending-manager PDA — closed here; rent returned to the pending manager.
    /// Seeds: `["factory_pending_manager"]`.
    #[account(
        mut,
        close = pending_manager,
        seeds = [pda_seeds::FACTORY_PENDING_MANAGER],
        bump = factory_pending_manager_pda.bump,
    )]
    pub factory_pending_manager_pda: Account<'info, FactoryPendingManager>,
}
