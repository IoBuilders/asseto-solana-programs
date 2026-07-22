use anchor_lang::prelude::*;
use common::pda_seeds;
use common::state::ASSET_CLASS_VERSION_STATE_DRAFT;

use crate::errors::ErrorCode;
use crate::helpers::{require_not_paused, verify_owner};
use crate::state::{AssetClassOwnership, AssetClassVersion, Factory};

pub fn init_asset_class_version(
    ctx: Context<InitAssetClassVersion>,
    config_id: u64,
    version: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_owner(
        &ctx.accounts.asset_class_ownership_pda,
        &ctx.accounts.owner.key(),
    )?;

    let expected_version = ctx
        .accounts
        .asset_class_ownership_pda
        .latest_version
        .checked_add(1)
        .ok_or(ErrorCode::Overflow)?;
    require_eq!(version, expected_version, ErrorCode::InvalidVersion);

    let bump = ctx.bumps.asset_class_version_pda;

    // `load_init` writes the discriminator and returns the zeroed account.
    let mut version_account = ctx.accounts.asset_class_version_pda.load_init()?;
    version_account.config_id = config_id;
    version_account.version = version;
    version_account.state = ASSET_CLASS_VERSION_STATE_DRAFT;
    version_account.bump = bump;

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64, version: u64)]
pub struct InitAssetClassVersion<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

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
        init,
        payer = owner,
        space = AssetClassVersion::DISCRIMINATOR.len() + std::mem::size_of::<AssetClassVersion>(),
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &config_id.to_le_bytes(), &version.to_le_bytes()],
        bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    pub system_program: Program<'info, System>,
}
