use anchor_lang::prelude::*;
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, require_role, roles,
};

use crate::events::AccountRemovedFromWhitelist;
use crate::state::WhitelistStatus;
use common::program_ids as constants;
use common::state::{AssetClassVersion, MintOwner, Roles};

/// Removes a token account from the whitelist for a mint by closing the marker PDA.
///
/// The `whitelist_pda` (seeds: `["whitelist", mint, account]`) is closed here and its
/// rent lamports are returned to the deployer.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
pub fn remove_from_whitelist(ctx: Context<RemoveFromWhitelist>) -> Result<()> {
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_CONTROL_LIST,
    )?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ──────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::TRANSFER_CONTROL_REMOVE_FROM_WHITELIST,
    )?;

    emit_cpi!(AccountRemovedFromWhitelist {
        mint: ctx.accounts.mint.key(),
        account: ctx.accounts.account.key(),
        operator: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct RemoveFromWhitelist<'info> {
    /// The authority — must sign and fund the PDA creation.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The authority's own `Roles` PDA.
    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, Roles>,

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

    /// The token account to remove from the whitelist.
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

    /// Whitelist marker PDA — closed here; rent returned to deployer.
    /// Seeds: `["whitelist", mint, account]`.
    #[account(
        mut,
        close = authority,
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
}
