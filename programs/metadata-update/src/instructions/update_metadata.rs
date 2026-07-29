use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed};
use anchor_spl::token_2022::Token2022;
use solana_system_interface::instruction as system_instruction;
use spl_token_2022::{
    extension::{BaseStateWithExtensions, StateWithExtensions},
    state::Mint as MintState,
};
use spl_token_metadata_interface::{
    instruction::update_field,
    state::{Field, TokenMetadata},
};

use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};
use common::{
    pda_seeds, pda_utils, require_active, require_functionality, require_not_paused, require_role,
    roles,
};

use crate::events::MetadataFieldUpdated;

fn to_field(key: String) -> Field {
    match key.to_lowercase().as_str() {
        "name" => Field::Name,
        "symbol" => Field::Symbol,
        "uri" => Field::Uri,
        _ => Field::Key(key),
    }
}

fn packed_meta_size(meta: &TokenMetadata) -> usize {
    32 // update_authority (OptionalNonZeroPubkey, always 32 bytes)
    + 32 // mint
    + 4 + meta.name.len()
    + 4 + meta.symbol.len()
    + 4 + meta.uri.len()
    + 4 // additional_metadata vec length prefix
    + meta.additional_metadata.iter()
        .map(|(k, v)| 4 + k.len() + 4 + v.len())
        .sum::<usize>()
}

fn new_packed_meta_size(meta: &TokenMetadata, field: &Field, new_value: &str) -> usize {
    let base = packed_meta_size(meta);
    match field {
        Field::Name => base - meta.name.len() + new_value.len(),
        Field::Symbol => base - meta.symbol.len() + new_value.len(),
        Field::Uri => base - meta.uri.len() + new_value.len(),
        Field::Key(k) => {
            if let Some((_, old_val)) = meta.additional_metadata.iter().find(|(key, _)| key == k) {
                base - old_val.len() + new_value.len()
            } else {
                // New entry: 4-byte key len + key + 4-byte val len + val
                base + 4 + k.len() + 4 + new_value.len()
            }
        }
    }
}

pub fn update_metadata_field(
    ctx: Context<UpdateMetadata>,
    key: String,
    value: String,
) -> Result<()> {
    let event_key = key.clone();
    let field = to_field(key);

    // ── Verify caller holds the role for the field being updated: Admin for
    // core identity fields (name/symbol), Data Manager for uri/custom fields ──
    let required_role = match field {
        Field::Name | Field::Symbol => roles::ROLE_ADMIN,
        Field::Uri | Field::Key(_) => roles::ROLE_CUSTOM_DATA_MANAGER,
    };
    require_role(ctx.accounts.authority_roles_pda.load()?, required_role)?;

    // ── Verify mint is not paused ────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ─────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::METADATA_UPDATE_UPDATE_METADATA_FIELD,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();
    let event_value = value.clone();

    // ── Compute and transfer any additional rent before the CPI ─────────────
    let additional_lamports = {
        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        let mint_state =
            StateWithExtensions::<MintState>::unpack(&mint_data).map_err(Error::from)?;
        let meta = mint_state
            .get_variable_len_extension::<TokenMetadata>()
            .map_err(Error::from)?;

        let old_size = packed_meta_size(&meta);
        let new_size = new_packed_meta_size(&meta, &field, &value);

        if new_size > old_size {
            let new_rent = Rent::get()?.minimum_balance(mint_data.len() + new_size - old_size);
            new_rent.saturating_sub(ctx.accounts.mint.lamports())
        } else {
            0
        }
    }; // mint_data borrow dropped here

    if additional_lamports > 0 {
        invoke(
            &system_instruction::transfer(ctx.accounts.payer.key, &mint_key, additional_lamports),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    // ── CPI: update_field ────────────────────────────────────────────────────
    let metadata_update_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::metadata_update_authority_seeds(&mint_key),
        &ctx.bumps.metadata_update_authority,
    );

    invoke_signed(
        &update_field(
            &token_program_id,
            &mint_key,
            &ctx.accounts.metadata_update_authority.key(),
            field,
            value,
        ),
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.metadata_update_authority.to_account_info(),
        ],
        &[metadata_update_signer_seeds.as_slice()],
    )?;

    emit_cpi!(MetadataFieldUpdated {
        mint: mint_key,
        operator: ctx.accounts.authority.key(),
        key: event_key,
        value: event_value,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct UpdateMetadata<'info> {
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
