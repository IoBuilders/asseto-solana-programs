use anchor_lang::prelude::*;
use common::{pda_seeds, require_active, verify_deployer, require_not_paused};

use crate::constants;
use crate::state::FrozenAccountStatus;

/// Freezes a specific token account at the management level by creating
/// an on-chain marker PDA.
///
/// The `frozen_account_pda` (seeds: `["frozen_account", mint, account]`) is created
/// here. Its existence signals that the account has been frozen by the deployer.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ────────────────────────────
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ──────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    // ── Record canonical bump in the frozen account marker PDA ───────────────
    ctx.accounts.frozen_account_pda.bump = ctx.bumps.frozen_account_pda;

    Ok(())
}

#[derive(Accounts)]
pub struct FreezeAccount<'info> {
    /// The deployer recorded as mint owner — must sign and fund the PDA creation.
    #[account(mut)]
    pub deployer: Signer<'info>,

    /// PDA created by deploy that records the deployer for this mint.
    ///
    /// CHECK: Address verified by seeds/bump; contents Borsh-deserialized by verify_deployer.
    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub mint_owner_pda: UncheckedAccount<'info>,

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
        space = FrozenAccountStatus::LEN,
        seeds = [pda_seeds::FROZEN_ACCOUNT, mint.key().as_ref(), account.key().as_ref()],
        bump,
    )]
    pub frozen_account_pda: Account<'info, FrozenAccountStatus>,

    pub system_program: Program<'info, System>,
}
