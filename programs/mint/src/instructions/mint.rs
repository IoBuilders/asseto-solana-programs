use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use cap::require_within_max_supply;
use common::pda_utils;
use common::state::Roles as RolesCommon;
use common::{pda_seeds, require_active, require_functionality, require_role, roles};
use freeze::cpi::accounts::{BlockAccount, UnblockAccount};
use spl_token_2022::instruction::mint_to;
use transfer_control::verify_transfer_control_mode;

use crate::events::Issued;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration};

pub fn mint(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
    require_role(ctx.accounts.authority_roles_pda.load()?, roles::ROLE_ISSUER)?;

    // ── Verify mint has not been deactivated ─────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::MINT_MINT,
    )?;

    // ── Transfer control mode check ──────────────────────────────────────
    verify_transfer_control_mode(
        &ctx.accounts.transfer_control_mode_pda.to_account_info(),
        &[&ctx.accounts.destination_whitelist_pda.to_account_info()],
    )?;

    // ── Supply cap check ─────────────────────────────────────────────────
    require_within_max_supply(
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.max_supply_pda.to_account_info(),
        ctx.accounts.asset_class_version_pda.load()?,
        amount,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let mint_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::mint_authority_seeds(&mint_key),
        &ctx.bumps.mint_authority,
    );

    // ── 1. Unblock destination (CPI to freeze) ─────────────────────────
    freeze::cpi::unblock_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        UnblockAccount {
            calling_authority: ctx.accounts.mint_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.destination.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[mint_authority_signer_seeds.as_slice()],
    ))?;

    // ── 2. Mint tokens (CPI to Token-2022) ──────────────────────────────────
    invoke_signed(
        &mint_to(
            &token_program_id,
            &mint_key,
            &ctx.accounts.destination.key(),
            &ctx.accounts.mint_authority.key(),
            &[],
            amount,
        )
        .map_err(Error::from)?,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.mint_authority.to_account_info(),
        ],
        &[mint_authority_signer_seeds.as_slice()],
    )?;

    emit_cpi!(Issued {
        mint: mint_key,
        operator: ctx.accounts.authority.key(),
        to: ctx.accounts.destination.key(),
        value: amount,
    });

    // ── 3. Re-block destination (CPI to freeze) ────────────────────────
    freeze::cpi::block_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        BlockAccount {
            calling_authority: ctx.accounts.mint_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.destination.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[mint_authority_signer_seeds.as_slice()],
    ))?;

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct MintTokens<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

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

    /// CHECK: Writable; validated by Token-2022 and freeze during CPIs.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::FREEZE_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub freeze_authority: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; contents read by verify_transfer_control_mode.
    #[account(
        seeds = [pda_seeds::TRANSFER_CONTROL_MODE, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub transfer_control_mode_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; existence checked by verify_transfer_control_mode if needed
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), destination.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub destination_whitelist_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; absence means no cap is set, contents read by require_within_max_supply.
    #[account(
        seeds = [pda_seeds::MAX_SUPPLY, mint.key().as_ref()],
        seeds::program = constants::CAP_PROGRAM_ID,
        bump,
    )]
    pub max_supply_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::FREEZE_PROGRAM_ID)]
    pub freeze_program: UncheckedAccount<'info>,

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

    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
