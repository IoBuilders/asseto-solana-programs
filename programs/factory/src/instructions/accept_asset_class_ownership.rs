use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_pending_owner};
use crate::state::{AssetClassOwnership, AssetClassPendingOwner, Factory};

/// Accepts a pending asset class ownership nomination for `config_id`, promoting
/// the pending owner to owner.
///
/// The recorded `pending_owner` becomes the new `asset_class_ownership.owner`, and
/// the `asset_class_pending_owner_pda` is closed (rent returned to the new owner).
///
/// Only the recorded `pending_owner` may call this, and only while the factory is
/// not paused.
pub fn accept_asset_class_ownership(
    ctx: Context<AcceptAssetClassOwnership>,
    _config_id: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_pending_owner(
        &ctx.accounts.asset_class_pending_owner_pda,
        &ctx.accounts.pending_owner.key(),
    )?;

    // ── Promote the pending owner to owner ────────────────────────────────────
    ctx.accounts.asset_class_ownership_pda.owner =
        ctx.accounts.asset_class_pending_owner_pda.pending_owner;

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64)]
pub struct AcceptAssetClassOwnership<'info> {
    /// The pending owner accepting the nomination — must sign; receives the
    /// closed PDA's lamports.
    #[account(mut)]
    pub pending_owner: Signer<'info>,

    /// Singleton factory config PDA. Seeds: `["factory"]`.
    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    /// Asset-class ownership PDA. Seeds: `["asset_class_ownership", config_id]`.
    /// `owner` is updated here.
    #[account(
        mut,
        seeds = [pda_seeds::ASSET_CLASS_OWNERSHIP, &config_id.to_le_bytes()],
        bump = asset_class_ownership_pda.bump,
    )]
    pub asset_class_ownership_pda: Account<'info, AssetClassOwnership>,

    /// Pending-owner PDA — closed here; rent returned to the pending owner.
    /// Seeds: `["asset_class_pending_owner", config_id]`.
    #[account(
        mut,
        close = pending_owner,
        seeds = [pda_seeds::ASSET_CLASS_PENDING_OWNER, &config_id.to_le_bytes()],
        bump = asset_class_pending_owner_pda.bump,
    )]
    pub asset_class_pending_owner_pda: Account<'info, AssetClassPendingOwner>,
}
