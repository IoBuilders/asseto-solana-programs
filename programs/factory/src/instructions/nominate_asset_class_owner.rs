use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_owner};
use crate::state::{AssetClassOwnership, AssetClassPendingOwner, Factory};

/// Nominates `new_owner` as the successor to the current owner of the asset class
/// identified by `config_id`.
///
/// Creates the `asset_class_pending_owner_pda` on the first call and overwrites
/// the recorded `pending_owner` on subsequent calls (`init_if_needed`), so the
/// current owner may freely re-nominate while a nomination is pending.
///
/// Only the current asset class `owner` may call this, and only while the factory
/// is not paused.
pub fn nominate_asset_class_owner(
    ctx: Context<NominateAssetClassOwner>,
    _config_id: u64,
    new_owner: Pubkey,
) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_owner(
        &ctx.accounts.asset_class_ownership_pda,
        &ctx.accounts.current_owner.key(),
    )?;

    // ── Record the nominee in the pending-owner PDA ───────────────────────────
    let pending = &mut ctx.accounts.asset_class_pending_owner_pda;
    pending.pending_owner = new_owner;
    pending.bump = ctx.bumps.asset_class_pending_owner_pda;

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64, new_owner: Pubkey)]
pub struct NominateAssetClassOwner<'info> {
    /// The current asset class owner — must sign and fund PDA creation if needed.
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

    /// Pending-owner PDA — created on first call, overwritten thereafter.
    /// Seeds: `["asset_class_pending_owner", config_id]`.
    #[account(
        init_if_needed,
        payer = current_owner,
        space = AssetClassPendingOwner::DISCRIMINATOR.len() + AssetClassPendingOwner::INIT_SPACE,
        seeds = [pda_seeds::ASSET_CLASS_PENDING_OWNER, &config_id.to_le_bytes()],
        bump,
    )]
    pub asset_class_pending_owner_pda: Account<'info, AssetClassPendingOwner>,

    pub system_program: Program<'info, System>,
}
