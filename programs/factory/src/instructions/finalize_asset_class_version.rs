use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::errors::ErrorCode;
use crate::helpers::{require_not_paused, verify_owner};
use crate::state::{AssetClassOwnership, AssetClassVersion, Factory, STATE_DRAFT, STATE_READY};

/// Seals a `Draft` asset-class version, making it immutable and usable.
///
/// Flips `state` to `Ready` and advances the asset class's `latest_version` to
/// this version. The mask is already fully allocated (fixed-size, zero-copy), so
/// there is nothing to "complete" — unwritten positions are simply `0` (disabled).
/// After this the version PDA is immutable and `deploy`/`mint` may hook to it.
///
/// Operational instruction — only the asset class `owner` may call this, and only
/// while the factory is not paused.
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
            version_account.state == STATE_DRAFT,
            ErrorCode::VersionNotDraft
        );
        require_eq!(
            version_account.version,
            expected_version,
            ErrorCode::InvalidVersion
        );
        version_account.state = STATE_READY;
        version_account.version
    };

    ctx.accounts.asset_class_ownership_pda.latest_version = version;

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64, version: u64)]
pub struct FinalizeAssetClassVersion<'info> {
    /// The asset class owner — must sign.
    pub owner: Signer<'info>,

    /// Singleton factory config PDA. Seeds: `["factory"]`.
    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    /// Asset-class ownership PDA. Seeds: `["asset_class_ownership", config_id]`.
    /// `latest_version` is advanced to this version here.
    #[account(
        mut,
        seeds = [pda_seeds::ASSET_CLASS_OWNERSHIP, &config_id.to_le_bytes()],
        bump = asset_class_ownership_pda.bump,
    )]
    pub asset_class_ownership_pda: Account<'info, AssetClassOwnership>,

    /// Asset-class version PDA — sealed here (Draft → Ready). Must be `Draft`.
    /// Seeds: `["asset_class_version", config_id, version]`.
    #[account(
        mut,
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &config_id.to_le_bytes(), &version.to_le_bytes()],
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,
}
