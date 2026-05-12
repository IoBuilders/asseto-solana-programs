use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use cmtat_common::pda_utils;
use spl_token_2022::extension::pausable::instruction::pause as spl_pause;
use cmtat_common::{pda_seeds, require_active, verify_deployer};

use crate::constants;

/// Pauses the Token-2022 mint.
///
/// Once paused, all minting, burning, and transfers on this mint are blocked
/// by Token-2022 until `unpause` is called.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
/// The `pausable_authority` PDA (owned by this program) signs the Token-2022 pause CPI.
pub fn pause(ctx: Context<PauseMint>) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ───────────────────────────
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;

    // ── Verify mint has not been deactivated ─────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let pausable_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::pausable_authority_seeds(&mint_key),
        &ctx.bumps.pausable_authority
    );

    // ── Pause via this program's PDA ─────────────────────────────────────────
    invoke_signed(
        &spl_pause(
            &token_program_id,
            &mint_key,
            &ctx.accounts.pausable_authority.key(),
            &[],
        )
        .map_err(Error::from)?,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.pausable_authority.to_account_info(),
        ],
        &[pausable_authority_signer_seeds.as_slice()],
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct PauseMint<'info> {
    /// The deployer recorded as mint owner — must sign to authorise pausing.
    pub deployer: Signer<'info>,

    /// PDA created by cmtat-deploy that records the deployer for this mint.
    ///
    /// CHECK: Address verified by seeds/bump; contents Anchor-deserialized by verify_deployer.
    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub mint_owner_pda: UncheckedAccount<'info>,

    /// Deactivation marker PDA — must not exist for the instruction to proceed.
    /// Seeds: `["deactivate", mint]`, owned by `cmtat-deactivate`.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// The Token-2022 mint to pause.
    ///
    /// CHECK: Writable; validated by Token-2022 during the pause CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    /// Pausable authority PDA — signs the Token-2022 pause CPI.
    /// Seeds: `["pausable_authority", mint]`.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::PAUSABLE_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub pausable_authority: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
}
