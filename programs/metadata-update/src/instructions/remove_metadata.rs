use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use spl_token_metadata_interface::instruction::remove_key;

use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};
use common::{
    pda_seeds, pda_utils, require_active, require_functionality, require_not_paused, require_role,
    roles,
};

use crate::events::MetadataFieldRemoved;

pub fn remove_metadata_field(
    ctx: Context<RemoveMetadata>,
    key: String,
    idempotent: bool,
) -> Result<()> {
    // ── Verify caller holds the custom-data-manager role ─────────────────────
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_CUSTOM_DATA_MANAGER,
    )?;

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
        operator: ctx.accounts.authority.key(),
        key: event_key,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct RemoveMetadata<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub authority: Signer<'info>,

    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, Roles>,

    /// CHECK: Validated by Token-2022 during the metadata CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::METADATA_UPDATE_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub metadata_update_authority: UncheckedAccount<'info>,

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

    #[account(
        seeds = [
            pda_seeds::ASSET_CLASS_VERSION,
            &asset_configuration_pda.asset_class_config_id.to_le_bytes(),
            &asset_configuration_pda.asset_class_version_id.to_le_bytes()
        ],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,
}
