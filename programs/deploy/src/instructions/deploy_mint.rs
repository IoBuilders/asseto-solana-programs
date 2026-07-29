use access_control::cpi::accounts::Initialize;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_spl::token_2022::Token2022;
use common::program_ids as constants;
use common::{pda_seeds, pda_utils};
use solana_system_interface::instruction as system_instruction;
use spl_token_2022_interface::{
    extension::{
        metadata_pointer::instruction::initialize as initialize_metadata_pointer,
        pausable::instruction::initialize as initialize_pausable,
        permissioned_burn::instruction::initialize as initialize_permissioned_burn,
        transfer_hook::instruction::initialize as initialize_transfer_hook_ext, ExtensionType,
    },
    instruction::{initialize_mint2, initialize_permanent_delegate, set_authority, AuthorityType},
    state::Mint as MintState,
};
use spl_token_metadata_interface::{
    instruction::{initialize as initialize_token_metadata, update_authority, update_field},
    solana_nullable::MaybeNull,
    state::{Field, TokenMetadata},
};

use crate::errors::ErrorCode;
use crate::events::MintDeployed;
use crate::state::AssetConfiguration;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MetadataField {
    pub key: String,
    pub value: String,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DeployMintParams {
    pub decimals: u8,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub additional_metadata: Vec<MetadataField>,
    pub asset_class_config_id: u64,
    pub asset_class_version_id: u64,
}

pub fn deploy_mint(ctx: Context<DeployMint>, params: DeployMintParams) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    // ── 1. Size calculation ──────────────────────────────────────────────────
    //
    // try_calculate_account_len only handles fixed-length extensions.
    // TokenMetadata is variable-length: initialize_token_metadata (step 8)
    // reallocates the account itself, so the account is created with
    // base_size only.
    //
    // However, initialize_mint2 (step 7) validates that the allocated account
    // length exactly matches try_calculate_account_len for the extensions
    // already written — so the account must be exactly base_size at that
    // point, not base_size + metadata.
    //
    // The account is pre-funded with lamports for the full size (base +
    // metadata) so that the realloc inside initialize_token_metadata succeeds
    // without requiring a separate lamport transfer.

    let base_size = ExtensionType::try_calculate_account_len::<MintState>(&[
        ExtensionType::PermanentDelegate,
        ExtensionType::MetadataPointer,
        ExtensionType::Pausable,
        ExtensionType::TransferHook,
        ExtensionType::PermissionedBurn,
    ])
    .map_err(|_| error!(ErrorCode::InvalidMintAccountSize))?;

    let metadata_tlv_size = TokenMetadata {
        name: params.name.clone(),
        symbol: params.symbol.clone(),
        uri: params.uri.clone(),
        additional_metadata: params
            .additional_metadata
            .iter()
            .map(|f| (f.key.clone(), f.value.clone()))
            .collect(),
        ..Default::default()
    }
    .tlv_size_of()
    .map_err(|_| error!(ErrorCode::InvalidMintAccountSize))?;

    // Fund for the full final size, but allocate only base_size bytes.
    let lamports = ctx
        .accounts
        .rent
        .minimum_balance(base_size + metadata_tlv_size);

    // ── 2. Create mint account ───────────────────────────────────────────────
    invoke(
        &system_instruction::create_account(
            ctx.accounts.payer.key,
            &mint_key,
            lamports,
            base_size as u64,
            &token_program_id,
        ),
        &[
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    // ── 3. MetadataPointer — must precede initialize_mint2 ──────────────────
    invoke(
        &initialize_metadata_pointer(
            &token_program_id,
            &mint_key,
            None, // no authority — pointer is permanently locked
            Some(mint_key),
        )
        .map_err(Error::from)?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    // ── 4. PermanentDelegate — must precede initialize_mint2 ────────────────
    invoke(
        &initialize_permanent_delegate(
            &token_program_id,
            &mint_key,
            &ctx.accounts.permanent_delegate_authority.key(),
        )
        .map_err(Error::from)?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    // ── 5. PermissionedBurn — must precede initialize_mint2 ────────────────
    invoke(
        &initialize_permissioned_burn(
            &token_program_id,
            &mint_key,
            &ctx.accounts.permissioned_burn_authority.key(),
        )
        .map_err(Error::from)?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    // ── 6. Pausable — must precede initialize_mint2 ─────────────────────────
    invoke(
        &initialize_pausable(
            &token_program_id,
            &mint_key,
            &ctx.accounts.pausable_authority.key(),
        )
        .map_err(Error::from)?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    // ── 7. TransferHook — must precede initialize_mint2 ─────────────────────
    invoke(
        &initialize_transfer_hook_ext(
            &token_program_id,
            &mint_key,
            Some(ctx.accounts.transfer_hook_authority.key()),
            Some(constants::TRANSFER_HOOK_PROGRAM_ID),
        )
        .map_err(Error::from)?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    // ── 8. initialize_mint2 ──────────────────────────────────────────────────
    //
    // No freeze authority. Freezing is marker-PDA based (`freeze`) and enforced by
    // `transfer::verify_transfer`, so nothing would ever sign with it. This is
    // irreversible: a mint's freeze authority can only be set here, and
    // `set_authority` requires the current one to sign, so these mints can never
    // gain a token-level freeze.
    invoke(
        &initialize_mint2(
            &token_program_id,
            &mint_key,
            &ctx.accounts.temp_mint_authority.key(),
            None,
            params.decimals,
        )
        .map_err(Error::from)?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    let temp_mint_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::temp_mint_authority_seeds(&mint_key),
        &ctx.bumps.temp_mint_authority,
    );

    // Capture the fields for the MintDeployed event before `params.name`,
    // `params.symbol`, `params.uri` (step 9) and `params.additional_metadata`
    // (step 10) are moved into the metadata CPIs below.
    let event_name = params.name.clone();
    let event_symbol = params.symbol.clone();
    let event_uri = params.uri.clone();
    let event_isin = params
        .additional_metadata
        .iter()
        .find(|f| f.key == "isin")
        .map(|f| f.value.clone());

    // ── 9. Initialize token metadata — must follow initialize_mint2 ─────────
    //
    // temp_mint_authority is used as the initial update authority so that this
    // program can sign the additional_metadata writes in step 10.  The update
    // authority is transferred to the external metadata_update_authority PDA
    // in step 11.
    invoke_signed(
        &initialize_token_metadata(
            &token_program_id,
            &mint_key,                               // metadata = mint
            &ctx.accounts.temp_mint_authority.key(), // update authority (temp)
            &mint_key,                               // mint
            &ctx.accounts.temp_mint_authority.key(), // mint authority (signer)
            params.name,
            params.symbol,
            params.uri,
        ),
        &[
            ctx.accounts.mint.to_account_info(), // metadata (writable)
            ctx.accounts.temp_mint_authority.to_account_info(), // update authority
            ctx.accounts.mint.to_account_info(), // mint
            ctx.accounts.temp_mint_authority.to_account_info(), // mint authority (signer)
        ],
        &[temp_mint_authority_signer_seeds.as_slice()],
    )?;

    // ── 10. Write additional_metadata fields ──────────────────────────────────
    for field in params.additional_metadata {
        invoke_signed(
            &update_field(
                &token_program_id,
                &mint_key,
                &ctx.accounts.temp_mint_authority.key(),
                Field::Key(field.key),
                field.value,
            ),
            &[
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.temp_mint_authority.to_account_info(),
            ],
            &[temp_mint_authority_signer_seeds.as_slice()],
        )?;
    }

    // ── 11. Transfer update authority to the external PDA ────────────────────
    let new_update_authority =
        MaybeNull::try_from(Some(ctx.accounts.metadata_update_authority.key()))
            .map_err(|_| error!(ErrorCode::InvalidMintAccountSize))?;

    invoke_signed(
        &update_authority(
            &token_program_id,
            &mint_key,
            &ctx.accounts.temp_mint_authority.key(),
            new_update_authority,
        ),
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.temp_mint_authority.to_account_info(),
        ],
        &[temp_mint_authority_signer_seeds.as_slice()],
    )?;

    // ── 12. Transfer mint authority to the external PDA ──────────────────────
    invoke_signed(
        &set_authority(
            &token_program_id,
            &mint_key,
            Some(&ctx.accounts.mint_authority.key()),
            AuthorityType::MintTokens,
            &ctx.accounts.temp_mint_authority.key(),
            &[],
        )
        .map_err(Error::from)?,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.temp_mint_authority.to_account_info(),
        ],
        &[temp_mint_authority_signer_seeds.as_slice()],
    )?;

    // ── 13. Record the mint configuration ────────────────────────────────
    ctx.accounts.asset_configuration_pda.asset_class_config_id = params.asset_class_config_id;
    ctx.accounts.asset_configuration_pda.asset_class_version_id = params.asset_class_version_id;
    ctx.accounts.asset_configuration_pda.bump = ctx.bumps.asset_configuration_pda;

    // ── 14. Initialize the ExtraAccountMetaList for the transfer hook ────────
    let asset_configuration_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::asset_configuration_seeds(&mint_key),
        &ctx.bumps.asset_configuration_pda,
    );
    transfer_hook::cpi::initialize_extra_account_meta_list(CpiContext::new_with_signer(
        constants::TRANSFER_HOOK_PROGRAM_ID,
        transfer_hook::cpi::accounts::InitializeExtraAccountMetaList {
            payer: ctx.accounts.payer.to_account_info(),
            asset_configuration_pda: ctx.accounts.asset_configuration_pda.to_account_info(),
            extra_account_meta_list: ctx.accounts.extra_account_meta_list.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
        },
        &[asset_configuration_signer_seeds.as_slice()],
    ))?;

    // ── 15. Grant ROLE_ADMIN to the deployer on this mint ─────────────────────
    access_control::cpi::initialize(CpiContext::new_with_signer(
        constants::ACCESS_CONTROL_PROGRAM_ID,
        Initialize {
            payer: ctx.accounts.payer.to_account_info(),
            temp_mint_authority: ctx.accounts.temp_mint_authority.to_account_info(),
            account: ctx.accounts.deployer.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            roles_pda: ctx.accounts.roles_pda.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
        &[temp_mint_authority_signer_seeds.as_slice()],
    ))?;

    // ── 16. Emit MintDeployed ────────────────────────────────────────────────
    emit_cpi!(MintDeployed {
        mint: mint_key,
        deployer: ctx.accounts.deployer.key(),
        decimals: params.decimals,
        name: event_name,
        symbol: event_symbol,
        uri: event_uri,
        isin: event_isin,
        asset_class_config_id: params.asset_class_config_id,
        asset_class_version_id: params.asset_class_version_id,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct DeployMint<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub deployer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = AssetConfiguration::DISCRIMINATOR.len() + AssetConfiguration::INIT_SPACE,
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: Uninitialized account validated entirely by Token-2022 during
    /// the extension and mint initialization CPIs below.
    #[account(mut, signer)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: PDA ownership proven by the seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::TEMP_MINT_AUTHORITY_SEED, mint.key().as_ref()],
        bump,
    )]
    pub temp_mint_authority: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::MINT_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::MINT_PROGRAM_ID,
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::PERMANENT_DELEGATE, mint.key().as_ref()],
        seeds::program = constants::OPERATIONS_PROGRAM_ID,
        bump,
    )]
    pub permanent_delegate_authority: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::PERMISSIONED_BURN, mint.key().as_ref()],
        seeds::program = constants::OPERATIONS_PROGRAM_ID,
        bump,
    )]
    pub permissioned_burn_authority: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::METADATA_UPDATE_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::METADATA_UPDATE_PROGRAM_ID,
        bump,
    )]
    pub metadata_update_authority: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::PAUSABLE_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::PAUSE_PROGRAM_ID,
        bump,
    )]
    pub pausable_authority: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::TRANSFER_HOOK_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump,
    )]
    pub transfer_hook_authority: UncheckedAccount<'info>,

    /// CHECK: Created during the CPI; seeds/bump verified by constraint.
    #[account(
        mut,
        seeds = [pda_seeds::EXTRA_ACCOUNT_METAS, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::TRANSFER_HOOK_PROGRAM_ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

    /// CHECK: Address verified by constraint.
    #[account(
        mut,
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), deployer.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub roles_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::ACCESS_CONTROL_PROGRAM_ID)]
    pub access_control_program: UncheckedAccount<'info>,
}
