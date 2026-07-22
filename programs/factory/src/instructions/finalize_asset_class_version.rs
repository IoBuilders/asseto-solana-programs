use anchor_lang::prelude::*;
use common::{
    pda_seeds, state::ASSET_CLASS_VERSION_STATE_DRAFT, state::ASSET_CLASS_VERSION_STATE_FINALIZED,
};

use crate::errors::ErrorCode;
use crate::helpers::{require_not_paused, verify_owner};
use crate::state::{AssetClassOwnership, AssetClassVersion, Factory};

pub fn finalize_asset_class_version(
    ctx: Context<FinalizeAssetClassVersion>,
    _config_id: u64,
    _version: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_owner(
        &ctx.accounts.asset_class_ownership_pda,
        &ctx.accounts.owner.key(),
    )?;

    // Defensive: the only existing draft is `latest_version + 1`.
    let expected_version = ctx
        .accounts
        .asset_class_ownership_pda
        .latest_version
        .checked_add(1)
        .ok_or(ErrorCode::Overflow)?;

    let version = {
        let mut version_account = ctx.accounts.asset_class_version_pda.load_mut()?;
        require!(
            version_account.state == ASSET_CLASS_VERSION_STATE_DRAFT,
            ErrorCode::VersionNotDraft
        );
        require_eq!(
            version_account.version,
            expected_version,
            ErrorCode::InvalidVersion
        );
        version_account.state = ASSET_CLASS_VERSION_STATE_FINALIZED;
        version_account.version
    };

    ctx.accounts.asset_class_ownership_pda.latest_version = version;

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64, version: u64)]
pub struct FinalizeAssetClassVersion<'info> {
    pub owner: Signer<'info>,

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
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &config_id.to_le_bytes(), &version.to_le_bytes()],
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,
}
