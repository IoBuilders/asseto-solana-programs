use crate::events::AccountFrozen;
use anchor_lang::prelude::*;
use common::{
    pda_seeds, require_active, require_functionality, require_not_paused, verify_deployer_account,
};

use crate::state::FrozenAccountStatus;
use common::program_ids as constants;
use common::state::{AssetClassVersion, MintOwner};

/// Freezes a specific token account at the management level by creating
/// an on-chain marker PDA.
///
/// The `frozen_account_pda` (seeds: `["frozen_account", mint, account]`) is created
/// here. Its existence signals that the account has been frozen by the deployer.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ────────────────────────────
    verify_deployer_account(&ctx.accounts.mint_owner_pda, &ctx.accounts.deployer.key())?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ──────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::FREEZE_FREEZE_ACCOUNT,
    )?;

    // ── Record canonical bump in the frozen account marker PDA ───────────────
    ctx.accounts.frozen_account_pda.bump = ctx.bumps.frozen_account_pda;

    emit_cpi!(AccountFrozen {
        mint: ctx.accounts.mint.key(),
        account: ctx.accounts.account.key(),
        operator: ctx.accounts.deployer.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct FreezeAccount<'info> {
    /// The deployer recorded as mint owner — must sign and fund the PDA creation.
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

    /// The token account to freeze at the token level.
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

    /// Frozen account marker PDA — created here to record that this token account
    /// has been frozen at the management level.
    /// Seeds: `["frozen_account", mint, account]`.
    #[account(
        init,
        payer = deployer,
        space = FrozenAccountStatus::DISCRIMINATOR.len() + FrozenAccountStatus::INIT_SPACE,
        seeds = [pda_seeds::FROZEN_ACCOUNT, mint.key().as_ref(), account.key().as_ref()],
        bump,
    )]
    pub frozen_account_pda: Account<'info, FrozenAccountStatus>,

    /// Asset-class version PDA this mint is hooked to.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &mint_owner_pda.asset_class_config_id.to_le_bytes(), &mint_owner_pda.asset_class_version_id.to_le_bytes()],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    pub system_program: Program<'info, System>,
}
