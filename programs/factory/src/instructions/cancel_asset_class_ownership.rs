use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_owner};
use crate::state::{AssetClassOwnership, AssetClassPendingOwner, Factory};

/// Cancels a pending asset class ownership nomination for `config_id`.
///
/// The `asset_class_pending_owner_pda` is closed (rent returned to the current
/// owner); `asset_class_ownership.owner` is left unchanged.
///
/// Only the current asset class `owner` may call this, and only while the factory
/// is not paused.
pub fn cancel_asset_class_ownership(
    ctx: Context<CancelAssetClassOwnership>,
    _config_id: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_owner(
        &ctx.accounts.asset_class_ownership_pda,
        &ctx.accounts.current_owner.key(),
    )?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64)]
pub struct CancelAssetClassOwnership<'info> {
    /// The current asset class owner — must sign; receives the closed PDA's lamports.
    #[account(mut)]
    pub current_owner: Signer<'info>,

    /// Singleton factory config PDA. Seeds: `["factory"]`.
    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    /// Asset-class ownership PDA. Seeds: `["asset_class_ownership", config_id]`.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_OWNERSHIP, &config_id.to_le_bytes()],
        bump = asset_class_ownership_pda.bump,
    )]
    pub asset_class_ownership_pda: Account<'info, AssetClassOwnership>,

    /// Pending-owner PDA — closed here; rent returned to the current owner.
    /// Seeds: `["asset_class_pending_owner", config_id]`.
    #[account(
        mut,
        close = current_owner,
        seeds = [pda_seeds::ASSET_CLASS_PENDING_OWNER, &config_id.to_le_bytes()],
        bump = asset_class_pending_owner_pda.bump,
    )]
    pub asset_class_pending_owner_pda: Account<'info, AssetClassPendingOwner>,
}
