use crate::errors::ErrorCode;
use crate::helpers::{require_not_paused, verify_owner};
use crate::state::{AssetClassOwnership, AssetClassVersion, Factory};
use anchor_lang::prelude::*;
use common::{bitmask, pda_seeds, state::ASSET_CLASS_VERSION_STATE_DRAFT};

/// Turns on the given functionality bits in a `Draft` asset-class version's mask.
///
/// For each entry in `functionalities`, sets the corresponding bit to `1` via
/// `mask[byte] |= 1 << bit` — a targeted merge, not an overwrite, so bits
/// outside the given list are left untouched. Rejected once the version is
/// sealed (`Ready`).
///
/// Operational instruction — only the asset class `owner` may call this, and only
/// while the factory is not paused.
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
    /// The asset class owner — must sign.
    pub owner: Signer<'info>,

    /// Singleton factory config PDA. Seeds: `["factory"]`.
    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    /// Asset-class ownership PDA. Seeds: `["asset_class_ownership", config_id]`.
    /// Read here to authorise the owner.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_OWNERSHIP, &config_id.to_le_bytes()],
        bump = asset_class_ownership_pda.bump,
    )]
    pub asset_class_ownership_pda: Account<'info, AssetClassOwnership>,

    /// Asset-class version PDA — written here. Must be `Draft`.
    /// Seeds: `["asset_class_version", config_id, version]`.
    #[account(
        mut,
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &config_id.to_le_bytes(), &version.to_le_bytes()],
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,
}
