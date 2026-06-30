use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::errors::ErrorCode;
use crate::helpers::{require_not_paused, verify_owner};
use crate::state::{
    AssetClassOwnership, AssetClassVersion, Factory, FUNCTIONALITIES_BYTES_MASK, STATE_DRAFT,
};

/// Writes a chunk of the functionality mask into a `Draft` asset-class version.
///
/// Copies `chunk` into the mask at byte `offset` (overwrite — the version is
/// built from scratch, so while it is a `Draft` the owner may freely set or
/// clear bits). The mask may be larger than one transaction, so the client
/// splits it into chunks (one call each); positions never written stay `0`
/// (disabled). Rejected once the version is sealed (`Ready`).
///
/// Operational instruction — only the asset class `owner` may call this, and only
/// while the factory is not paused.
pub fn write_asset_class_version_mask(
    ctx: Context<WriteAssetClassVersionMask>,
    _config_id: u64,
    _version: u64,
    offset: u32,
    chunk: Vec<u8>,
) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_owner(
        &ctx.accounts.asset_class_ownership_pda,
        &ctx.accounts.owner.key(),
    )?;

    let mut version_account = ctx.accounts.asset_class_version_pda.load_mut()?;
    require!(
        version_account.state == STATE_DRAFT,
        ErrorCode::VersionNotDraft
    );

    let start = offset as usize;
    let end = start.checked_add(chunk.len()).ok_or(ErrorCode::Overflow)?;
    require!(
        end <= FUNCTIONALITIES_BYTES_MASK,
        ErrorCode::MaskChunkOutOfBounds
    );

    version_account.mask[start..end].copy_from_slice(&chunk);

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64, version: u64)]
pub struct WriteAssetClassVersionMask<'info> {
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
