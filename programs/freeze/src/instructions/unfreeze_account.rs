use crate::events::AccountUnfrozen;
use anchor_lang::prelude::*;
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, verify_deployer_account,
};

use crate::state::FrozenAccountStatus;
use common::program_ids as constants;
use common::state::{AssetClassVersion, MintOwner};

/// Unfreezes a specific token account at the management level by closing
/// the frozen account marker PDA previously created by `freeze_account`.
///
/// The `frozen_account_pda` (seeds: `["frozen_account", mint, account]`) is closed
/// here and its rent lamports are returned to the deployer.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
pub fn unfreeze_account(ctx: Context<UnfreezeAccount>) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ────────────────────────────
    verify_deployer_account(&ctx.accounts.mint_owner_pda, &ctx.accounts.deployer.key())?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ──────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::FREEZE_UNFREEZE_ACCOUNT,
    )?;

    emit_cpi!(AccountUnfrozen {
        mint: ctx.accounts.mint.key(),
        account: ctx.accounts.account.key(),
        operator: ctx.accounts.deployer.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct UnfreezeAccount<'info> {
    /// The deployer recorded as mint owner — must sign; receives the closed PDA's lamports.
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

    /// The token account to unfreeze at the token level.
    ///
    /// CHECK: Address used as a seed for frozen_account_pda; not otherwise validated here.
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

    /// Frozen account marker PDA — closed here; rent returned to deployer.
    /// Seeds: `["frozen_account", mint, account]`.
    #[account(
        mut,
        close = deployer,
        seeds = [pda_seeds::FROZEN_ACCOUNT, mint.key().as_ref(), account.key().as_ref()],
        bump = frozen_account_pda.bump,
    )]
    pub frozen_account_pda: Account<'info, FrozenAccountStatus>,

    /// Asset-class version PDA this mint is hooked to.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &mint_owner_pda.asset_class_config_id.to_le_bytes(), &mint_owner_pda.asset_class_version_id.to_le_bytes()],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,
}
