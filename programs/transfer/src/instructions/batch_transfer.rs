use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token_2022::Token2022;
use common::pda_seeds;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration};
use spl_token_2022_interface::{
    extension::StateWithExtensions, instruction::transfer_checked, state::Mint as MintState,
};

use crate::errors::TransferError;

pub fn batch_transfer<'info>(
    ctx: Context<'info, BatchTransferTokens<'info>>,
    amounts: Vec<u64>,
) -> Result<()> {
    require!(!amounts.is_empty(), TransferError::EmptyBatch);
    // Two remaining accounts per leg: destination token account + its whitelist
    // PDA (the metalist resolves the destination whitelist from the destination,
    // so the hook needs that account forwarded on every leg).
    require!(
        ctx.remaining_accounts.len() == amounts.len() * 2,
        TransferError::InvalidRemainingAccounts
    );

    let decimals = {
        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        let mint_state =
            StateWithExtensions::<MintState>::unpack(&mint_data).map_err(Error::from)?;
        mint_state.base.decimals
    };

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    for (i, &amount) in amounts.iter().enumerate() {
        let destination = &ctx.remaining_accounts[i * 2];
        let destination_whitelist_pda = &ctx.remaining_accounts[i * 2 + 1];

        // ── Transfer ───────────────────────────────────────────────────────
        let mut transfer_ix = transfer_checked(
            &token_program_id,
            &ctx.accounts.source.key(),
            &mint_key,
            &destination.key(),
            &ctx.accounts.source_owner.key(),
            &[],
            amount,
            decimals,
        )?;

        // Forwarded to the hook in metalist order; the destination whitelist is
        // this leg's, the rest are constant.
        for meta in [
            ctx.accounts.extra_account_meta_list.key(),
            ctx.accounts.transfer_hook_program.key(),
            ctx.accounts.deploy_program.key(),
            ctx.accounts.asset_configuration_pda.key(),
            ctx.accounts.factory_program.key(),
            ctx.accounts.asset_class_version_pda.key(),
            ctx.accounts.deactivate_program.key(),
            ctx.accounts.deactivate_pda.key(),
            ctx.accounts.transfer_control_program.key(),
            ctx.accounts.transfer_control_mode_pda.key(),
            ctx.accounts.source_whitelist_pda.key(),
            destination_whitelist_pda.key(),
            ctx.accounts.freeze_program.key(),
            ctx.accounts.source_frozen_pda.key(),
            ctx.accounts.source_frozen_balance_pda.key(),
        ] {
            transfer_ix
                .accounts
                .push(AccountMeta::new_readonly(meta, false));
        }

        invoke(
            &transfer_ix,
            &[
                ctx.accounts.source.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                destination.to_account_info(),
                ctx.accounts.source_owner.to_account_info(),
                ctx.accounts.extra_account_meta_list.to_account_info(),
                ctx.accounts.transfer_hook_program.to_account_info(),
                ctx.accounts.deploy_program.to_account_info(),
                ctx.accounts.asset_configuration_pda.to_account_info(),
                ctx.accounts.factory_program.to_account_info(),
                ctx.accounts.asset_class_version_pda.to_account_info(),
                ctx.accounts.deactivate_program.to_account_info(),
                ctx.accounts.deactivate_pda.to_account_info(),
                ctx.accounts.transfer_control_program.to_account_info(),
                ctx.accounts.transfer_control_mode_pda.to_account_info(),
                ctx.accounts.source_whitelist_pda.to_account_info(),
                destination_whitelist_pda.to_account_info(),
                ctx.accounts.freeze_program.to_account_info(),
                ctx.accounts.source_frozen_pda.to_account_info(),
                ctx.accounts.source_frozen_balance_pda.to_account_info(),
            ],
        )?;
    }

    Ok(())
}

/// Accounts for `batch_transfer`.
///
/// Indices 0–2 (`source_owner`, `source`, `mint`) are fixed. The constant
/// compliance PDAs and program ids the hook needs are named accounts; the
/// per-leg `(destination, destination_whitelist_pda)` pairs are appended as
/// `remaining_accounts` (`remaining_accounts.len() == amounts.len() * 2`).
#[derive(Accounts)]
pub struct BatchTransferTokens<'info> {
    /// 0 — Token holder authorising the batch.
    /// Token-2022's `transfer_checked` validates that this matches `source.owner`.
    pub source_owner: Signer<'info>,

    /// 1 — Source token account (shared by every leg).
    /// CHECK: Writable; owner verified by Token-2022 during `transfer_checked`.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,

    /// 2 — The Token-2022 mint.
    /// CHECK: Validated by Token-2022 during CPI; decimals read in instruction body.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::EXTRA_ACCOUNT_METAS, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::TRANSFER_HOOK_PROGRAM_ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to the hook.
    #[account(address = constants::FREEZE_PROGRAM_ID)]
    pub freeze_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to the hook.
    #[account(address = constants::DEPLOY_PROGRAM_ID)]
    pub deploy_program: UncheckedAccount<'info>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: Address verified by constraint; forwarded to the hook.
    #[account(address = constants::FACTORY_PROGRAM_ID)]
    pub factory_program: UncheckedAccount<'info>,

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

    /// CHECK: Address verified by constraint; forwarded to the hook.
    #[account(address = constants::DEACTIVATE_PROGRAM_ID)]
    pub deactivate_program: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook (require_active reads it).
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to the hook.
    #[account(address = constants::TRANSFER_CONTROL_PROGRAM_ID)]
    pub transfer_control_program: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook (may be empty — no mode active).
    #[account(
        seeds = [pda_seeds::TRANSFER_CONTROL_MODE, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub transfer_control_mode_pda: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook (must exist in whitelist mode).
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), source.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub source_whitelist_pda: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook (must be empty for transfers to proceed).
    #[account(
        seeds = [pda_seeds::FROZEN_ACCOUNT, mint.key().as_ref(), source.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_pda: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook (may be empty — no partial freeze).
    #[account(
        seeds = [pda_seeds::FROZEN_BALANCE, mint.key().as_ref(), source.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_balance_pda: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
}
