use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use common::pda_utils;
use common::state::Roles as RolesCommon;
use common::{pda_seeds, require_active, require_functionality, require_role, roles};
use freeze::cpi::accounts::{BlockAccount, UnblockAccount};
use spl_token_2022::instruction::burn as spl_burn;

use crate::errors::OperationsError;
use crate::events::ControllerRedemption;
use common::program_ids as constants;
use common::state::{AssetClassVersion, MintOwner};

pub fn batch_burn<'info>(
    ctx: Context<'info, BatchBurnTokens<'info>>,
    amounts: Vec<u64>,
) -> Result<()> {
    require!(!amounts.is_empty(), OperationsError::EmptyBatch);
    require!(
        ctx.remaining_accounts.len() == amounts.len(),
        OperationsError::InvalidRemainingAccounts
    );

    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_CONTROLLER,
    )?;

    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::OPERATIONS_BURN,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let permanent_delegate_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::permanent_delegate_seeds(&mint_key),
        &ctx.bumps.operations_authority,
    );

    for i in 0..amounts.len() {
        let amount = amounts[i];
        let destination = &ctx.remaining_accounts[i];
        let destination_key = destination.key();

        // ── 1. Unblock destination (CPI to freeze) ────────────────────────────
        freeze::cpi::unblock_account(CpiContext::new_with_signer(
            constants::FREEZE_PROGRAM_ID,
            UnblockAccount {
                calling_authority: ctx.accounts.operations_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: destination.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[permanent_delegate_signer_seeds.as_slice()],
        ))?;

        // ── 2. Burn tokens (CPI to Token-2022) ────────────────────────────────
        invoke_signed(
            &spl_burn(
                &token_program_id,
                &destination.key(),
                &mint_key,
                &ctx.accounts.operations_authority.key(),
                &[],
                amount,
            )
            .map_err(Error::from)?,
            &[
                destination.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.operations_authority.to_account_info(),
            ],
            &[permanent_delegate_signer_seeds.as_slice()],
        )?;

        emit_cpi!(ControllerRedemption {
            mint: mint_key,
            controller: ctx.accounts.authority.key(),
            from: destination_key,
            value: amount,
        });

        // ── 3. Re-block destination (CPI to freeze) ───────────────────────────
        freeze::cpi::block_account(CpiContext::new_with_signer(
            constants::FREEZE_PROGRAM_ID,
            BlockAccount {
                calling_authority: ctx.accounts.operations_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: destination.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[permanent_delegate_signer_seeds.as_slice()],
        ))?;
    }

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct BatchBurnTokens<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = mint_owner_pda.bump,
    )]
    pub mint_owner_pda: Account<'info, MintOwner>,

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

    /// Operations authority PDA — acts as the permanent delegate for this mint.
    /// Seeds: `["permanent_delegate", mint]`.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::PERMANENT_DELEGATE, mint.key().as_ref()],
        bump,
    )]
    pub operations_authority: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::FREEZE_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub freeze_authority: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::FREEZE_PROGRAM_ID)]
    pub freeze_program: UncheckedAccount<'info>,

    #[account(
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &mint_owner_pda.asset_class_config_id.to_le_bytes(), &mint_owner_pda.asset_class_version_id.to_le_bytes()],
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
