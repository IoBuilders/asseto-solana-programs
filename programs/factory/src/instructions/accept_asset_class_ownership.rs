use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_pending_owner};
use crate::state::{AssetClassOwnership, AssetClassPendingOwner, Factory};

pub fn accept_asset_class_ownership(
    ctx: Context<AcceptAssetClassOwnership>,
    _config_id: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_pending_owner(
        &ctx.accounts.asset_class_pending_owner_pda,
        &ctx.accounts.pending_owner.key(),
    )?;

    ctx.accounts.asset_class_ownership_pda.owner =
        ctx.accounts.asset_class_pending_owner_pda.pending_owner;

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64)]
pub struct AcceptAssetClassOwnership<'info> {
    #[account(mut)]
    pub pending_owner: Signer<'info>,

    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    #[account(
        mut,
        seeds = [pda_seeds::ASSET_CLASS_OWNERSHIP, &config_id.to_le_bytes()],
        bump = asset_class_ownership_pda.bump,
    )]
    pub asset_class_ownership_pda: Account<'info, AssetClassOwnership>,

    #[account(
        mut,
        close = pending_owner,
        seeds = [pda_seeds::ASSET_CLASS_PENDING_OWNER, &config_id.to_le_bytes()],
        bump = asset_class_pending_owner_pda.bump,
    )]
    pub asset_class_pending_owner_pda: Account<'info, AssetClassPendingOwner>,
}
