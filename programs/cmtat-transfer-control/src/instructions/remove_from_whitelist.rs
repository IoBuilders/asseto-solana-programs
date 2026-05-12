use anchor_lang::prelude::*;
use cmtat_common::{require_active, verify_deployer, require_not_paused};

use crate::constants;
use crate::state::WhitelistStatus;

/// Removes a token account from the whitelist for a mint by closing the marker PDA.
///
/// The `whitelist_pda` (seeds: `["whitelist", mint, account]`) is closed here and its
/// rent lamports are returned to the deployer.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
pub fn remove_from_whitelist(ctx: Context<RemoveFromWhitelist>) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ────────────────────────────
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ──────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    Ok(())
}

#[derive(Accounts)]
pub struct RemoveFromWhitelist<'info> {
    /// The deployer recorded as mint owner — must sign; receives the closed PDA's lamports.
    #[account(mut)]
    pub deployer: Signer<'info>,

    /// PDA created by cmtat-deploy that records the deployer for this mint.
    ///
    /// CHECK: Address verified by seeds/bump; contents Borsh-deserialized by verify_deployer.
    #[account(
        seeds = [b"mint_owner", mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub mint_owner_pda: UncheckedAccount<'info>,

    /// The Token-2022 mint.
    ///
    /// CHECK: Read-only; validated by require_not_paused (checks the Pausable extension).
    pub mint: UncheckedAccount<'info>,

    /// The token account to remove from the whitelist.
    ///
    /// CHECK: Address used as a seed for whitelist_pda; not otherwise validated here.
    pub account: UncheckedAccount<'info>,

    /// Deactivation marker PDA — must not exist for the instruction to proceed.
    /// Seeds: `["deactivate", mint]`, owned by `cmtat-deactivate`.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [b"deactivate", mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// Whitelist marker PDA — closed here; rent returned to deployer.
    /// Seeds: `["whitelist", mint, account]`.
    #[account(
        mut,
        close = deployer,
        seeds = [b"whitelist", mint.key().as_ref(), account.key().as_ref()],
        bump,
    )]
    pub whitelist_pda: Account<'info, WhitelistStatus>,
}
