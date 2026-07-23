use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_manager};
use crate::state::{AssetClassOwnership, Factory};

pub fn create_asset_class(
    ctx: Context<CreateAssetClass>,
    _config_id: u64,
    owner: Pubkey,
) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_manager(&ctx.accounts.factory, &ctx.accounts.manager.key())?;

    let asset_class = &mut ctx.accounts.asset_class_ownership_pda;
    asset_class.owner = owner;
    asset_class.latest_version = 0;
    asset_class.bump = ctx.bumps.asset_class_ownership_pda;

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64, owner: Pubkey)]
pub struct CreateAssetClass<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    #[account(
        init,
        payer = manager,
        space = AssetClassOwnership::DISCRIMINATOR.len() + AssetClassOwnership::INIT_SPACE,
        seeds = [pda_seeds::ASSET_CLASS_OWNERSHIP, &config_id.to_le_bytes()],
        bump,
    )]
    pub asset_class_ownership_pda: Account<'info, AssetClassOwnership>,

    pub system_program: Program<'info, System>,
}
