use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_owner};
use crate::state::{AssetClassOwnership, AssetClassPendingOwner, Factory};

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

    let pending = &mut ctx.accounts.asset_class_pending_owner_pda;
    pending.pending_owner = new_owner;
    pending.bump = ctx.bumps.asset_class_pending_owner_pda;

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64, new_owner: Pubkey)]
pub struct NominateAssetClassOwner<'info> {
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
        init_if_needed,
        payer = current_owner,
        space = AssetClassPendingOwner::DISCRIMINATOR.len() + AssetClassPendingOwner::INIT_SPACE,
        seeds = [pda_seeds::ASSET_CLASS_PENDING_OWNER, &config_id.to_le_bytes()],
        bump,
    )]
    pub asset_class_pending_owner_pda: Account<'info, AssetClassPendingOwner>,

    pub system_program: Program<'info, System>,
}
