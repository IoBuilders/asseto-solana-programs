use crate::errors::ErrorCode;
use crate::helpers::{require_not_paused, verify_owner};
use crate::state::{AssetClassOwnership, AssetClassVersion, Factory};
use anchor_lang::prelude::*;
use common::{bitmask, pda_seeds, state::ASSET_CLASS_VERSION_STATE_DRAFT};

pub fn enable_asset_class_version_functionalities(
    ctx: Context<EnableAssetClassVersionFunctionalities>,
    _config_id: u64,
    _version: u64,
    functionalities: Vec<u16>,
) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_owner(
        &ctx.accounts.asset_class_ownership_pda,
        &ctx.accounts.owner.key(),
    )?;

    let mut version_account = ctx.accounts.asset_class_version_pda.load_mut()?;
    require!(
        version_account.state == ASSET_CLASS_VERSION_STATE_DRAFT,
        ErrorCode::VersionNotDraft
    );

    bitmask::set_bits(&mut version_account.mask, &functionalities)
        .map_err(|_| error!(ErrorCode::FunctionalityOutOfBounds))?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64, version: u64)]
pub struct EnableAssetClassVersionFunctionalities<'info> {
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
        mut,
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &config_id.to_le_bytes(), &version.to_le_bytes()],
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,
}
