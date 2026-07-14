use anchor_lang::prelude::*;
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, verify_deployer_account,
};

use crate::events::AccountWhitelisted;
use crate::state::WhitelistStatus;
use common::program_ids as constants;
use common::state::{AssetClassVersion, MintOwner};

/// Adds a token account to the whitelist for a mint by creating a marker PDA.
///
/// The `whitelist_pda` (seeds: `["whitelist", mint, account]`) is created on first call.
/// If the PDA already exists the instruction is a no-op (idempotent).
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
pub fn add_to_whitelist(ctx: Context<AddToWhitelist>) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ────────────────────────────
    verify_deployer_account(&ctx.accounts.mint_owner_pda, &ctx.accounts.deployer.key())?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ──────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::TRANSFER_CONTROL_ADD_TO_WHITELIST,
    )?;

    // ── Record canonical bump in the whitelist marker PDA ─────────────────────
    ctx.accounts.whitelist_pda.bump = ctx.bumps.whitelist_pda;

    emit_cpi!(AccountWhitelisted {
        mint: ctx.accounts.mint.key(),
        account: ctx.accounts.account.key(),
        operator: ctx.accounts.deployer.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct AddToWhitelist<'info> {
    /// The deployer recorded as mint owner — must sign and fund PDA creation if needed.
    #[account(mut)]
    pub deployer: Signer<'info>,

    /// PDA created by deploy that records the deployer for this mint.
    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = mint_owner_pda.bump,
    )]
    pub mint_owner_pda: Account<'info, MintOwner>,

    /// The Token-2022 mint.
    ///
    /// CHECK: Read-only; validated by require_not_paused (checks the Pausable extension).
    pub mint: UncheckedAccount<'info>,

    /// The token account to add to the whitelist.
    ///
    /// CHECK: Address used as a seed for whitelist_pda; not otherwise validated here.
    pub account: UncheckedAccount<'info>,

    /// Deactivation marker PDA — must not exist for the instruction to proceed.
    /// Seeds: `["deactivate", mint]`, owned by `deactivate`.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// Whitelist marker PDA — created on first call; no-op if already exists.
    /// Seeds: `["whitelist", mint, account]`.
    #[account(
        init_if_needed,
        payer = deployer,
        space = WhitelistStatus::DISCRIMINATOR.len() + WhitelistStatus::INIT_SPACE,
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), account.key().as_ref()],
        bump,
    )]
    pub whitelist_pda: Account<'info, WhitelistStatus>,

    /// Asset-class version PDA this mint is hooked to.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &mint_owner_pda.asset_class_config_id.to_le_bytes(), &mint_owner_pda.asset_class_version_id.to_le_bytes()],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    pub system_program: Program<'info, System>,
}
