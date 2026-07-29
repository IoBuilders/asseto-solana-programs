use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use cap::require_within_max_supply;
use common::pda_utils;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};
use common::{
    pda_seeds, require_active, require_functionality, require_role, roles, verify_whitelist_pda,
};
use spl_token_2022_interface::instruction::mint_to;
use transfer_control::verify_whitelist;

use crate::errors::MintError;
use crate::events::Issued;
use common::program_ids as constants;

pub fn batch_mint<'info>(
    ctx: Context<'info, BatchMintTokens<'info>>,
    amounts: Vec<u64>,
) -> Result<()> {
    require!(!amounts.is_empty(), MintError::EmptyBatch);
    require!(
        ctx.remaining_accounts.len() == amounts.len() * 2,
        MintError::InvalidRemainingAccounts
    );

    require_role(ctx.accounts.authority_roles_pda.load()?, roles::ROLE_ISSUER)?;

    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::MINT_MINT,
    )?;

    // ── Supply cap check ─────────────────────────────────────────────────────
    // Once on the batch total rather than per destination: `require_within_max_supply`
    // unpacks the mint's TLV, so checking in the loop would pay that N times for an
    // equivalent result (final supply = initial + sum, and intermediates only ever
    // undershoot it).
    let batch_total = amounts
        .iter()
        .try_fold(0u64, |acc, amount| acc.checked_add(*amount))
        .ok_or(MintError::AmountOverflow)?;

    require_within_max_supply(
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.max_supply_pda.to_account_info(),
        ctx.accounts.asset_class_version_pda.load()?,
        batch_total,
    )?;

    let whitelist_active = !ctx
        .accounts
        .transfer_control_mode_pda
        .to_account_info()
        .data_is_empty();

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let mint_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::mint_authority_seeds(&mint_key),
        &ctx.bumps.mint_authority,
    );

    for i in 0..amounts.len() {
        let amount = amounts[i];
        let destination = &ctx.remaining_accounts[i * 2];
        let destination_whitelist_pda = &ctx.remaining_accounts[i * 2 + 1];
        let destination_key = destination.key();

        if whitelist_active {
            verify_whitelist_pda(destination_whitelist_pda, &destination_key, &mint_key)?;
            verify_whitelist(&destination_whitelist_pda.to_account_info())?;
        }

        // ──  Mint tokens (CPI to Token-2022) ────────────────────────────────
        invoke_signed(
            &mint_to(
                &token_program_id,
                &mint_key,
                &destination.key(),
                &ctx.accounts.mint_authority.key(),
                &[],
                amount,
            )
            .map_err(Error::from)?,
            &[
                ctx.accounts.mint.to_account_info(),
                destination.to_account_info(),
                ctx.accounts.mint_authority.to_account_info(),
            ],
            &[mint_authority_signer_seeds.as_slice()],
        )?;

        emit_cpi!(Issued {
            mint: mint_key,
            operator: ctx.accounts.authority.key(),
            to: destination_key,
            value: amount,
        });
    }

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct BatchMintTokens<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// CHECK: Writable; validated by Token-2022 during the mint_to CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::MINT_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; absence means no cap is set, contents read by require_within_max_supply.
    #[account(
        seeds = [pda_seeds::MAX_SUPPLY, mint.key().as_ref()],
        seeds::program = constants::CAP_PROGRAM_ID,
        bump,
    )]
    pub max_supply_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; contents read by get_transfer_mode.
    #[account(
        seeds = [pda_seeds::TRANSFER_CONTROL_MODE, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub transfer_control_mode_pda: UncheckedAccount<'info>,

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

    pub token_2022_program: Program<'info, Token2022>,

    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,
}
