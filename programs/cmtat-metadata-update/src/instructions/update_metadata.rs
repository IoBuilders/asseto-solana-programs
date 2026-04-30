use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, program::invoke, system_instruction};
use anchor_spl::token_2022::Token2022;
use spl_token_2022::{
    extension::{BaseStateWithExtensions, StateWithExtensions},
    state::Mint as MintState,
};
use spl_token_metadata_interface::{
    instruction::update_field,
    state::{Field, TokenMetadata},
};

use crate::constants;
use cmtat_common::verify_deactivate;
use cmtat_common::verify_deployer;
use cmtat_common::verify_unpause;


/// Converts a plain string key into the typed `Field` enum.
/// "name", "symbol", "uri" map to their dedicated variants;
/// anything else becomes a custom `Field::Key`.
fn to_field(key: String) -> Field {
    match key.to_lowercase().as_str() {
        "name" => Field::Name,
        "symbol" => Field::Symbol,
        "uri" => Field::Uri,
        _ => Field::Key(key),
    }
}

/// Returns the byte size of a packed `TokenMetadata` TLV entry (data portion only).
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

/// Returns the packed size after applying `field = new_value` to `meta`.
fn new_packed_meta_size(meta: &TokenMetadata, field: &Field, new_value: &str) -> usize {
    let base = packed_meta_size(meta);
    match field {
        Field::Name   => base - meta.name.len()   + new_value.len(),
        Field::Symbol => base - meta.symbol.len() + new_value.len(),
        Field::Uri    => base - meta.uri.len()    + new_value.len(),
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

/// Updates the value of an existing metadata field (name / symbol / uri or any
/// custom key) or adds a new custom key-value pair if the key does not yet exist.
///
/// The required lamport top-up is computed on-chain from the current metadata:
/// the instruction reads the existing `TokenMetadata` extension, simulates the
/// field update, computes the byte growth, and transfers the exact additional
/// rent from `payer` to the mint account before calling `update_field`.
pub fn update_metadata_field(
    ctx: Context<UpdateMetadata>,
    key: String,
    value: String,
) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ───────────────────────────
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;

    // ── Verify mint is not paused ────────────────────────────────────────────
    verify_unpause(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ─────────────────────────────────
    verify_deactivate(&ctx.accounts.deactivate_pda.to_account_info())?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();
    let field = to_field(key);

    // ── Compute and transfer any additional rent before the CPI ─────────────
    let additional_lamports = {
        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        let mint_state = StateWithExtensions::<MintState>::unpack(&mint_data)
            .map_err(anchor_lang::error::Error::from)?;
        let meta = mint_state
            .get_variable_len_extension::<TokenMetadata>()
            .map_err(anchor_lang::error::Error::from)?;

        let old_size = packed_meta_size(&meta);
        let new_size = new_packed_meta_size(&meta, &field, &value);

        if new_size > old_size {
            let new_rent =
                Rent::get()?.minimum_balance(mint_data.len() + new_size - old_size);
            new_rent.saturating_sub(ctx.accounts.mint.lamports())
        } else {
            0
        }
    }; // mint_data borrow dropped here

    if additional_lamports > 0 {
        invoke(
            &system_instruction::transfer(
                ctx.accounts.payer.key,
                &mint_key,
                additional_lamports,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    // ── CPI: update_field ────────────────────────────────────────────────────
    let seeds: &[&[u8]] = &[
        b"metadata_update_authority",
        mint_key.as_ref(),
        &[ctx.bumps.metadata_update_authority],
    ];

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
        &[seeds],
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateMetadata<'info> {
    /// Pays for any additional rent when the account needs to grow.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The deployer recorded as mint owner in mint_owner_pda.
    /// Must sign to authorise metadata changes.
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
    /// on-chain token metadata. Owned by this program; signs update_field CPIs.
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
}
