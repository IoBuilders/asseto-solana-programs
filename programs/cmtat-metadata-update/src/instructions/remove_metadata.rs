use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed};
use anchor_spl::token_2022::Token2022;
use spl_token_metadata_interface::{
    instruction::{remove_key},
};

use crate::constants;
use cmtat_common::verify_deactivate;
use cmtat_common::verify_deployer;
use cmtat_common::verify_unpause;


/// Removes a custom key-value pair from `additional_metadata`.
///
/// Note: only custom keys can be removed.  The core fields (name, symbol, uri)
/// cannot be removed — use `update_metadata_field` to clear their values.
///
/// Set `idempotent = true` to silently succeed when the key does not exist.
pub fn remove_metadata_field(
    ctx: Context<RemoveMetadata>,
    key: String,
    idempotent: bool,
) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ───────────────────────────
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;

    // ── Verify mint is not paused ───────────────────────────
    verify_unpause(
        &ctx.accounts.mint.to_account_info(),
    )?;

    // ── Verify mint has not been deactivated ─────────────────────────────────
    verify_deactivate(&ctx.accounts.deactivate_pda.to_account_info())?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let seeds: &[&[u8]] = &[
        b"metadata_update_authority",
        mint_key.as_ref(),
        &[ctx.bumps.metadata_update_authority],
    ];

    invoke_signed(
        &remove_key(
            &token_program_id,
            &mint_key,
            &ctx.accounts.metadata_update_authority.key(),
            key,
            idempotent,
        ),
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.metadata_update_authority.to_account_info(),
        ],
         &[seeds],
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct RemoveMetadata<'info> {
    /// Pays for any additional rent when the account needs to grow.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The deployer recorded as mint owner in mint_owner_pda.
    /// Must sign to authorise metadata field removal.
    pub deployer: Signer<'info>,

    /// The Token-2022 mint whose embedded metadata is being modified.
    ///
    /// CHECK: Validated by Token-2022 during the metadata CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    /// PDA created by cmtat-deploy that records the deployer for this mint.
    /// The seeds constraint guarantees this is the canonical PDA for the mint;
    /// the instruction body checks that `deployer` matches the stored pubkey via
    /// Anchor deserialization (MintOwner::try_deserialize) inside verify_deployer.
    /// UncheckedAccount is used because Account<MintOwner> would enforce ownership
    /// by the current program, but this account is owned by cmtat-deploy.
    ///
    /// CHECK: Address verified by seeds/bump; contents Anchor-deserialized by verify_deployer.
    #[account(
        seeds = [b"mint_owner", mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub mint_owner_pda: UncheckedAccount<'info>,

    /// Metadata update authority PDA — the only key authorised to modify
    /// on-chain token metadata. Owned by this program; signs remove_key CPIs.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [b"metadata_update_authority", mint.key().as_ref()],
        bump,
    )]
    pub metadata_update_authority: UncheckedAccount<'info>,

    /// Deactivation marker PDA — must not exist for the instruction to proceed.
    /// Seeds: `["deactivate", mint]`, owned by `cmtat-deactivate`.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked by verify_deactivate.
    #[account(
        seeds = [b"deactivate", mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
