use anchor_lang::prelude::*;
use common::pda_seeds;
use common::state::ASSET_CLASS_VERSION_STATE_DRAFT;

use crate::errors::ErrorCode;
use crate::helpers::{require_not_paused, verify_owner};
use crate::state::{AssetClassOwnership, AssetClassVersion, Factory};

/// Starts deploying a new version of asset class `config_id`.
///
/// Creates the fixed-size, zero-copy `asset_class_version_pda` (seeds:
/// `["asset_class_version", config_id, version]`) in `Draft` with an empty
/// (all-zero) mask. The mask is then filled by
/// `enable_asset_class_version_functionalities` /
/// `disable_asset_class_version_functionalities` and sealed by
/// `finalize_asset_class_version`.
///
/// `version` must be `asset_class_ownership.latest_version + 1`. Each version is
/// independent — it defines its own functionalities from scratch and inherits
/// nothing from previous versions.
///
/// Operational instruction — only the asset class `owner` may call this, and only
/// while the factory is not paused.
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
    /// The asset class owner — must sign and fund the version PDA.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Singleton factory config PDA. Seeds: `["factory"]`.
    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    /// Asset-class ownership PDA. Seeds: `["asset_class_ownership", config_id]`.
    /// Read here to authorise the owner and pin `version`.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_OWNERSHIP, &config_id.to_le_bytes()],
        bump = asset_class_ownership_pda.bump,
    )]
    pub asset_class_ownership_pda: Account<'info, AssetClassOwnership>,

    /// Asset-class version PDA, created here (fixed size) in `Draft` state.
    /// Seeds: `["asset_class_version", config_id, version]`. `init` fails if the
    /// version already exists.
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
