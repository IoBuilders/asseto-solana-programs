use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use spl_token_metadata_interface::instruction::remove_key;

use common::program_ids as constants;
use common::state::{AssetClassVersion, MintOwner};
use common::{
    pda_seeds, pda_utils, require_active, require_functionality, require_not_paused,
    verify_deployer_account,
};

use crate::events::MetadataFieldRemoved;

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
    verify_deployer_account(&ctx.accounts.mint_owner_pda, &ctx.accounts.deployer.key())?;

    // ── Verify mint is not paused ───────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ─────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::METADATA_UPDATE_REMOVE_METADATA_FIELD,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();
    let event_key = key.clone();

    let metadata_update_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::metadata_update_authority_seeds(&mint_key),
        &ctx.bumps.metadata_update_authority,
    );

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
        &[metadata_update_signer_seeds.as_slice()],
    )?;

    emit_cpi!(MetadataFieldRemoved {
        mint: mint_key,
        operator: ctx.accounts.deployer.key(),
        key: event_key,
    });

    Ok(())
}

#[event_cpi]
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

    /// PDA created by deploy that records the deployer for this mint.
    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = mint_owner_pda.bump,
    )]
    pub mint_owner_pda: Account<'info, MintOwner>,

    /// Metadata update authority PDA — the only key authorised to modify
    /// on-chain token metadata. Owned by this program; signs remove_key CPIs.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::METADATA_UPDATE_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub metadata_update_authority: UncheckedAccount<'info>,

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

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

    /// Asset-class version PDA this mint is hooked to.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &mint_owner_pda.asset_class_config_id.to_le_bytes(), &mint_owner_pda.asset_class_version_id.to_le_bytes()],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,
}
