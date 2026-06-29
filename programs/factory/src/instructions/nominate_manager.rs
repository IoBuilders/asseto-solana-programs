use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_manager};
use crate::state::{Factory, FactoryPendingManager};

/// Nominates `new_manager` as the successor to the current factory manager.
///
/// Creates the `factory_pending_manager_pda` on the first call and overwrites
/// the recorded `pending_manager` on subsequent calls (`init_if_needed`), so the
/// current manager may freely re-nominate while a nomination is pending.
///
/// Management instruction — only the current `factory.manager` may call this, and
/// only while the factory is not paused.
pub fn nominate_manager(ctx: Context<NominateManager>, new_manager: Pubkey) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_manager(&ctx.accounts.factory, &ctx.accounts.current_manager.key())?;

    // ── Record the nominee in the pending-manager PDA ─────────────────────────
    let pending = &mut ctx.accounts.factory_pending_manager_pda;
    pending.pending_manager = new_manager;
    pending.bump = ctx.bumps.factory_pending_manager_pda;

    Ok(())
}

#[derive(Accounts)]
pub struct NominateManager<'info> {
    /// The current factory manager — must sign and fund PDA creation if needed.
    #[account(mut)]
    pub current_manager: Signer<'info>,

    /// Singleton factory config PDA. Seeds: `["factory"]`.
    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    /// Pending-manager PDA — created on first call, overwritten thereafter.
    /// Seeds: `["factory_pending_manager"]`.
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
