use anchor_lang::prelude::*;
use cmtat_common::{verify_deployer, require_not_paused};

use crate::constants;
use crate::state::DeactivateStatus;

/// Deactivates the Token-2022 mint by creating an on-chain marker PDA.
///
/// The `deactivate_pda` (seeds: `["deactivate", mint]`) is created here.
/// Its existence on-chain signals that the mint has been permanently deactivated.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
pub fn deactivate(ctx: Context<Deactivate>) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ────────────────────────────
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Record canonical bump in the deactivation marker PDA ─────────────────
    ctx.accounts.deactivate_pda.bump = ctx.bumps.deactivate_pda;

    Ok(())
}

#[derive(Accounts)]
pub struct Deactivate<'info> {
    /// The deployer recorded as mint owner — must sign and fund the PDA creation.
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

    /// The Token-2022 mint to deactivate.
    ///
    /// CHECK: Read-only; validated by require_not_paused (checks the Pausable extension).
    pub mint: UncheckedAccount<'info>,

    /// Deactivation marker PDA — created here to record that this mint has been deactivated.
    /// Seeds: `["deactivate", mint]`.
    #[account(
        init,
        payer = deployer,
        space = DeactivateStatus::LEN,
        seeds = [b"deactivate", mint.key().as_ref()],
        bump,
    )]
    pub deactivate_pda: Account<'info, DeactivateStatus>,

    pub system_program: Program<'info, System>,
}
