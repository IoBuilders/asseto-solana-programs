use anchor_lang::prelude::*;
use common::{pda_seeds, require_active, verify_deployer, require_not_paused};

use crate::constants;
use crate::state::FrozenBalance;

/// Records (or updates) a frozen balance for a specific token account.
///
/// The `frozen_balance_pda` (seeds: `["frozen_balance", mint, account]`) is
/// created on first call and its `balance` field overwritten on subsequent calls.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
pub fn partially_freeze_account(ctx: Context<PartiallyFreezeAccount>, balance: u64) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ────────────────────────────
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ──────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    // ── Set (or overwrite) the frozen balance ─────────────────────────────────
    ctx.accounts.frozen_balance_pda.balance = balance;
    ctx.accounts.frozen_balance_pda.bump    = ctx.bumps.frozen_balance_pda;

    Ok(())
}

#[derive(Accounts)]
pub struct PartiallyFreezeAccount<'info> {
    /// The deployer recorded as mint owner — must sign and fund PDA creation if needed.
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

    /// The token account to partially freeze.
    ///
    /// CHECK: Address used as a seed for frozen_balance_pda; not otherwise validated here.
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

    /// Frozen balance PDA — created on first call, updated on subsequent calls.
    /// Seeds: `["frozen_balance", mint, account]`.
    #[account(
        init_if_needed,
        payer = deployer,
        space = FrozenBalance::DISCRIMINATOR.len() + FrozenBalance::INIT_SPACE,
        seeds = [pda_seeds::FROZEN_BALANCE, mint.key().as_ref(), account.key().as_ref()],
        bump,
    )]
    pub frozen_balance_pda: Account<'info, FrozenBalance>,

    pub system_program: Program<'info, System>,
}
