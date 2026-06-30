use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::helpers::{require_not_paused, verify_manager};
use crate::state::{AssetClassOwnership, Factory};

/// Creates a new asset class identified by `config_id` and owned by `owner`,
/// creating its ownership PDA.
///
/// The `asset_class_ownership_pda` (seeds: `["asset_class_ownership", config_id]`)
/// is created here with `latest_version` initialised to 0. The `init` constraint
/// makes this fail if an asset class already exists for `config_id`.
///
/// Management instruction — only the current `factory.manager` may call this, and
/// only while the factory is not paused.
pub fn create_asset_class(
    ctx: Context<CreateAssetClass>,
    config_id: u64,
    owner: Pubkey,
) -> Result<()> {
    require_not_paused(&ctx.accounts.factory)?;
    verify_manager(&ctx.accounts.factory, &ctx.accounts.manager.key())?;

    // ── Record the asset class's owner, version and bump ──────────────────────
    let asset_class = &mut ctx.accounts.asset_class_ownership_pda;
    asset_class.owner = owner;
    asset_class.latest_version = 0;
    asset_class.bump = ctx.bumps.asset_class_ownership_pda;

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64, owner: Pubkey)]
pub struct CreateAssetClass<'info> {
    /// The current factory manager — must sign and fund PDA creation.
    #[account(mut)]
    pub manager: Signer<'info>,

    /// Singleton factory config PDA. Seeds: `["factory"]`.
    #[account(
        seeds = [pda_seeds::FACTORY],
        bump = factory.bump,
    )]
    pub factory: Account<'info, Factory>,

    /// Asset-class ownership PDA — created here.
    /// Seeds: `["asset_class_ownership", config_id]`. `init` fails if it already exists.
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
