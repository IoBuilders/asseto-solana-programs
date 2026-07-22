use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_owner};
use crate::state::{AssetClassOwnership, AssetClassPendingOwner, Factory};

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
    #[account(mut)]
    pub current_owner: Signer<'info>,

    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    #[account(
        seeds = [pda_seeds::ASSET_CLASS_OWNERSHIP, &config_id.to_le_bytes()],
        bump = asset_class_ownership_pda.bump,
    )]
    pub asset_class_ownership_pda: Account<'info, AssetClassOwnership>,

    #[account(
        mut,
        close = current_owner,
        seeds = [pda_seeds::ASSET_CLASS_PENDING_OWNER, &config_id.to_le_bytes()],
        bump = asset_class_pending_owner_pda.bump,
    )]
    pub asset_class_pending_owner_pda: Account<'info, AssetClassPendingOwner>,
}
