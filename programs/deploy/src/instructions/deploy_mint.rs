use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_spl::token_2022::Token2022;
use common::program_ids as constants;
use common::{pda_seeds, pda_utils};
use solana_system_interface::instruction as system_instruction;
use spl_pod::optional_keys::OptionalNonZeroPubkey;
use spl_token_2022::{
    extension::{
        default_account_state::instruction::initialize_default_account_state,
        metadata_pointer::instruction::initialize as initialize_metadata_pointer,
        pausable::instruction::initialize as initialize_pausable,
        transfer_hook::instruction::initialize as initialize_transfer_hook_ext, ExtensionType,
    },
    instruction::{initialize_mint2, initialize_permanent_delegate, set_authority, AuthorityType},
    state::{AccountState, Mint as MintState},
};
use spl_token_metadata_interface::{
    instruction::{initialize as initialize_token_metadata, update_authority, update_field},
    state::{Field, TokenMetadata},
};

use crate::errors::ErrorCode;
use crate::state::MintOwner;

const TEMP_MINT_AUTHORITY_SEED: &[u8] = b"temp_mint_authority";

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
    /// Optional custom key-value pairs written to additional_metadata at deploy time.
    pub additional_metadata: Vec<MetadataField>,
}

/// Deploys a new Token-2022 mint with the following extensions, each governed
/// by a distinct program-derived authority owned by an external program:
///
/// | Extension          | Authority PDA seeds                    | Owner program                       |
/// |--------------------|----------------------------------------|-------------------------------------|
/// | Mint authority     | `["mint_authority",             mint]` | MINT_PROGRAM_ID           |
/// | PermanentDelegate  | `["permanent_delegate",         mint]` | OPERATIONS_PROGRAM_ID       |
/// | TransferHook       | `["transfer_hook_authority",    mint]` | TRANSFER_HOOK_PROGRAM_ID  |
/// | MetadataPointer    | n/a (points to mint itself)            | none — immutable             |
/// | Metadata update    | `["metadata_update_authority",  mint]` | METADATA_UPDATE_PROGRAM_ID  |
/// | Pausable           | `["pausable_authority",         mint]` | PAUSE_PROGRAM_ID       |
///
/// To bootstrap metadata initialization (which requires the mint authority to
/// sign), a temporary PDA owned by this program is used as mint authority for
/// steps 8–11, then replaced by the final external mint authority PDA in step 12.
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
        ExtensionType::DefaultAccountState,
        ExtensionType::TransferHook,
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
    //
    // Points to the mint account itself as the metadata storage location.
    // No update authority: once set, the metadata pointer is immutable.
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

    // ── 5. DefaultAccountState — must precede initialize_mint2 ──────────────
    //
    // All new token accounts for this mint are created in the Frozen state.
    // Because the mint has no freeze authority, these accounts can never be
    // thawed — tokens are effectively non-transferable without the
    // PermanentDelegate or another compliant mechanism.
    invoke(
        &initialize_default_account_state(&token_program_id, &mint_key, &AccountState::Frozen)
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
    //
    // Sets the transfer hook authority to the transfer_hook_authority PDA
    // (owned by transfer-hook) and the program to call on every transfer
    // to transfer-hook.
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
    // temp_mint_authority (our program's PDA) is set as the initial mint
    // authority so that our program can sign the metadata initialization in
    // step 8 and the authority transfer in step 9.
    // Token-2022 requires a non-null freeze authority when DefaultAccountState
    // is Frozen (step 5). The freeze_authority PDA is owned by freeze
    // (FREEZE_PROGRAM_ID = freeze::ID). freeze uses this
    // PDA to transiently thaw and re-freeze accounts during mint, burn, and
    // transfer operations.
    invoke(
        &initialize_mint2(
            &token_program_id,
            &mint_key,
            &ctx.accounts.temp_mint_authority.key(),
            Some(&ctx.accounts.freeze_authority.key()),
            params.decimals,
        )
        .map_err(Error::from)?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    let temp_mint_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        vec![TEMP_MINT_AUTHORITY_SEED, mint_key.as_ref()],
        &ctx.bumps.temp_mint_authority,
    );

    // ── 9. Initialize token metadata — must follow initialize_mint2 ─────────
    //
    // temp_mint_authority is used as the initial update authority so that this
    // program can sign the additional_metadata writes in step 9.  The update
    // authority is transferred to the external metadata_update_authority PDA
    // in step 10.
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
    //
    // Each field is appended via update_field, signed by temp_mint_authority
    // which is still the update authority at this point.
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
    //
    // temp_mint_authority hands over update authority to metadata_update_authority,
    // owned by METADATA_UPDATE_PROGRAM_ID.
    let new_update_authority =
        OptionalNonZeroPubkey::try_from(Some(ctx.accounts.metadata_update_authority.key()))
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
    //
    // temp_mint_authority hands over control to mint_authority, which is
    // owned by MINT_PROGRAM_ID.  After this point our program has
    // no further control over minting.
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

    // ── 13. Record the deployer as mint owner ────────────────────────────────
    ctx.accounts.mint_owner_pda.deployer = ctx.accounts.deployer.key();
    ctx.accounts.mint_owner_pda.bump = ctx.bumps.mint_owner_pda;

    // ── 14. Initialize the ExtraAccountMetaList for the transfer hook ────────
    //
    // CPI signed with mint_owner_pda so that the transfer hook program can verify
    // this call originates from deploy_mint for this specific mint.
    let mint_owner_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::mint_owner_seeds(&mint_key),
        &ctx.bumps.mint_owner_pda,
    );
    transfer_hook::cpi::initialize_extra_account_meta_list(
        CpiContext::new_with_signer(
            constants::TRANSFER_HOOK_PROGRAM_ID,
            transfer_hook::cpi::accounts::InitializeExtraAccountMetaList {
                payer: ctx.accounts.payer.to_account_info(),
                mint_owner_pda: ctx.accounts.mint_owner_pda.to_account_info(),
                extra_account_meta_list: ctx.accounts.extra_account_meta_list.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            &[mint_owner_signer_seeds.as_slice()],
        ),
        ctx.accounts.deployer.key(),
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct DeployMint<'info> {
    /// Pays for all rent-exempt accounts created during deployment
    /// (mint account and mint_owner_pda).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The entity that becomes the recorded owner of this mint.
    /// Must sign to authorize being stored as the deployer.
    /// Can be the same wallet as `payer`.
    pub deployer: Signer<'info>,

    /// PDA that records the deployer as this mint's owner.
    /// Seeds: `["mint_owner", mint]` — unique per mint, owned by this program.
    #[account(
        init,
        payer = payer,
        space = MintOwner::DISCRIMINATOR.len() + MintOwner::INIT_SPACE,
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        bump,
    )]
    pub mint_owner_pda: Account<'info, MintOwner>,

    /// The new Token-2022 mint account.
    /// Must be a fresh keypair that signs the transaction so that
    /// SystemProgram::create_account can allocate it.
    ///
    /// CHECK: Uninitialized account validated entirely by Token-2022 during
    /// the extension and mint initialization CPIs below.
    #[account(mut, signer)]
    pub mint: UncheckedAccount<'info>,

    /// Temporary mint authority owned by our program.
    /// Set as mint authority during initialization so our program can sign
    /// the metadata initialization and then transfer authority to mint_authority.
    /// This PDA holds no lamports and stores no data — it exists only as a
    /// signing key for steps 8–12 of this instruction.
    ///
    /// CHECK: PDA ownership proven by the seeds/bump constraint.
    #[account(
        seeds = [TEMP_MINT_AUTHORITY_SEED, mint.key().as_ref()],
        bump,
    )]
    pub temp_mint_authority: UncheckedAccount<'info>,

    /// Final mint authority: controls future token minting.
    /// Owned by MINT_PROGRAM_ID — stored as the destination address
    /// for the authority transfer in step 9; does not sign during deployment.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::MINT_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::MINT_PROGRAM_ID,
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// PermanentDelegate authority: can transfer/burn any token account.
    /// Owned by OPERATIONS_PROGRAM_ID — stored as an address only;
    /// does not sign during mint deployment.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::PERMANENT_DELEGATE, mint.key().as_ref()],
        seeds::program = constants::OPERATIONS_PROGRAM_ID,
        bump,
    )]
    pub permanent_delegate_authority: UncheckedAccount<'info>,

    /// Metadata update authority: can update token name/symbol/uri fields.
    /// Owned by METADATA_UPDATE_PROGRAM_ID — stored as an address only
    /// during deployment; required as a Signer in update_metadata instructions.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::METADATA_UPDATE_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::METADATA_UPDATE_PROGRAM_ID,
        bump,
    )]
    pub metadata_update_authority: UncheckedAccount<'info>,

    /// Pausable authority: can pause and resume minting/burning/transfers.
    /// Owned by PAUSE_PROGRAM_ID — stored as an address only.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::PAUSABLE_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::PAUSE_PROGRAM_ID,
        bump,
    )]
    pub pausable_authority: UncheckedAccount<'info>,

    /// Freeze authority: satisfies the Token-2022 requirement that a mint with
    /// DefaultAccountState::Frozen must have a non-null freeze authority.
    /// Owned by FREEZE_PROGRAM_ID — a program that is never deployed,
    /// so no one can ever sign a thaw instruction; token accounts are permanently frozen.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::FREEZE_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub freeze_authority: UncheckedAccount<'info>,

    /// Transfer hook authority PDA for this mint.
    /// Set as the TransferHook extension authority during mint deployment.
    /// Owned by transfer-hook.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::TRANSFER_HOOK_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump,
    )]
    pub transfer_hook_authority: UncheckedAccount<'info>,

    /// ExtraAccountMetaList PDA for the transfer hook.
    /// Created and initialized by the initialize_extra_account_meta_list CPI (step 14).
    ///
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
}
