use crate::events::Deactivated;
use anchor_lang::prelude::*;
use common::{pda_seeds, require_functionality, require_not_paused, verify_deployer_account};

use crate::state::DeactivateStatus;
use common::program_ids as constants;
use common::state::{AssetClassVersion, MintOwner};

/// Deactivates the Token-2022 mint by creating an on-chain marker PDA.
///
/// The `deactivate_pda` (seeds: `["deactivate", mint]`) is created here.
/// Its existence on-chain signals that the mint has been permanently deactivated.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
pub fn deactivate(ctx: Context<Deactivate>) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ────────────────────────────
    verify_deployer_account(&ctx.accounts.mint_owner_pda, &ctx.accounts.deployer.key())?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::DEACTIVATE_DEACTIVATE,
    )?;

    // ── Record canonical bump in the deactivation marker PDA ─────────────────
    ctx.accounts.deactivate_pda.bump = ctx.bumps.deactivate_pda;

    emit_cpi!(Deactivated {
        mint: ctx.accounts.mint.key(),
        operator: ctx.accounts.deployer.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct Deactivate<'info> {
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

    /// The Token-2022 mint to deactivate.
    ///
    /// CHECK: Read-only; validated by require_not_paused (checks the Pausable extension).
    pub mint: UncheckedAccount<'info>,

    /// Deactivation marker PDA — created here to record that this mint has been deactivated.
    /// Seeds: `["deactivate", mint]`.
    #[account(
        init,
        payer = deployer,
        space = DeactivateStatus::DISCRIMINATOR.len() + DeactivateStatus::INIT_SPACE,
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        bump,
    )]
    pub deactivate_pda: Account<'info, DeactivateStatus>,

    /// Asset-class version PDA this mint is hooked to.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &mint_owner_pda.asset_class_config_id.to_le_bytes(), &mint_owner_pda.asset_class_version_id.to_le_bytes()],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    pub system_program: Program<'info, System>,
}
