use crate::events::Unpaused;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use common::{pda_seeds, require_active};
use common::{pda_utils, require_functionality, verify_deployer_account};
use spl_token_2022::extension::pausable::instruction::resume as spl_resume;

use common::program_ids as constants;
use common::state::{AssetClassVersion, MintOwner};

/// Unpauses (resumes) the Token-2022 mint.
///
/// Lifts the pause set by `pause`, allowing minting, burning, and transfers
/// to proceed normally again.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
/// The `pausable_authority` PDA (owned by this program) signs the Token-2022 resume CPI.
pub fn unpause(ctx: Context<UnpauseMint>) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ───────────────────────────
    verify_deployer_account(&ctx.accounts.mint_owner_pda, &ctx.accounts.deployer.key())?;

    // ── Verify mint has not been deactivated ─────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::PAUSE_UNPAUSE,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let pausable_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::pausable_authority_seeds(&mint_key),
        &ctx.bumps.pausable_authority,
    );

    // ── Resume via this program's PDA ────────────────────────────────────────
    invoke_signed(
        &spl_resume(
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

    emit_cpi!(Unpaused {
        mint: mint_key,
        operator: ctx.accounts.deployer.key(),
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct UnpauseMint<'info> {
    /// The deployer recorded as mint owner — must sign to authorise unpausing.
    pub deployer: Signer<'info>,

    /// PDA created by deploy that records the deployer for this mint.
    ///
    /// CHECK: Address verified by seeds/bump; contents Anchor-deserialized by verify_deployer.
    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = mint_owner_pda.bump,
    )]
    pub mint_owner_pda: Account<'info, MintOwner>,

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

    /// The Token-2022 mint to unpause (resume).
    ///
    /// CHECK: Writable; validated by Token-2022 during the resume CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    /// Pausable authority PDA — signs the Token-2022 resume CPI.
    /// Seeds: `["pausable_authority", mint]`.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::PAUSABLE_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub pausable_authority: UncheckedAccount<'info>,

    /// Asset-class version PDA this mint is hooked to.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &mint_owner_pda.asset_class_config_id.to_le_bytes(), &mint_owner_pda.asset_class_version_id.to_le_bytes()],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    pub token_2022_program: Program<'info, Token2022>,
}
