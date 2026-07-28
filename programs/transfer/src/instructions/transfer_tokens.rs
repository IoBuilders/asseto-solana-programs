use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token_2022::Token2022;
use common::program_ids as constants;
use common::{pda_seeds, pda_utils};
use freeze::cpi::accounts::{BlockAccount, UnblockAccount};
use spl_token_2022::{
    extension::StateWithExtensions, instruction::transfer_checked, state::Mint as MintState,
};

pub fn transfer(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
    // ── Read mint decimals ───────────────────────────────────────────────────
    let decimals = {
        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        let mint_state =
            StateWithExtensions::<MintState>::unpack(&mint_data).map_err(Error::from)?;
        mint_state.base.decimals
    };

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let transfer_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::transfer_seeds(&mint_key),
        &ctx.bumps.transfer_authority,
    );

    // ── 1. Unblock source and destination (CPI to freeze) ─────────────
    freeze::cpi::unblock_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        UnblockAccount {
            calling_authority: ctx.accounts.transfer_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.source.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[transfer_authority_signer_seeds.as_slice()],
    ))?;

    freeze::cpi::unblock_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        UnblockAccount {
            calling_authority: ctx.accounts.transfer_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.destination.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[transfer_authority_signer_seeds.as_slice()],
    ))?;

    // ── 2. Transfer ─────────────────────────────────────────────────────────
    let mut transfer_ix = transfer_checked(
        &token_program_id,
        &ctx.accounts.source.key(),
        &mint_key,
        &ctx.accounts.destination.key(),
        &ctx.accounts.source_owner.key(),
        &[],
        amount,
        decimals,
    )?;

    // Forwarded to transfer-hook::execute. Order is load-bearing: it must match
    // the ExtraAccountMetaList (see docs/transfer.md).
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
        ctx.accounts.destination_whitelist_pda.key(),
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
            ctx.accounts.destination.to_account_info(),
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
            ctx.accounts.destination_whitelist_pda.to_account_info(),
            ctx.accounts.freeze_program.to_account_info(),
            ctx.accounts.source_frozen_pda.to_account_info(),
            ctx.accounts.source_frozen_balance_pda.to_account_info(),
        ],
    )?;

    // ── 3. Re-block source and destination (CPI to freeze) ────────────
    freeze::cpi::block_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        BlockAccount {
            calling_authority: ctx.accounts.transfer_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.source.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[transfer_authority_signer_seeds.as_slice()],
    ))?;

    freeze::cpi::block_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        BlockAccount {
            calling_authority: ctx.accounts.transfer_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.destination.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[transfer_authority_signer_seeds.as_slice()],
    ))?;

    Ok(())
}

/// Accounts for `transfer`.
///
/// Indices 0–3 (`source_owner`, `source`, `destination`, `mint`) plus this
/// program's own freeze-CPI dependencies, followed by every account the transfer
/// hook's `ExtraAccountMetaList` references — Token-2022 forwards them to
/// `transfer-hook::execute`, which enforces compliance.
#[derive(Accounts)]
pub struct TransferTokens<'info> {
    /// 0 — Token holder authorising the transfer.
    /// Token-2022's `transfer_checked` validates that this matches `source.owner`.
    pub source_owner: Signer<'info>,

    /// 1 — Source token account.
    /// CHECK: Writable; owner verified by Token-2022 during `transfer_checked`.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,

    /// 2 — Destination token account.
    /// CHECK: Writable; validated by Token-2022 during `transfer_checked`.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    /// 3 — The Token-2022 mint.
    /// CHECK: Validated by Token-2022 during CPI; decimals read in instruction body.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::TRANSFER, mint.key().as_ref()],
        bump,
    )]
    pub transfer_authority: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::FREEZE_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub freeze_authority: UncheckedAccount<'info>,

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

    /// CHECK: Address verified by constraint; used for freeze CPIs and forwarded to the hook.
    #[account(address = constants::FREEZE_PROGRAM_ID)]
    pub freeze_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to the hook.
    #[account(address = constants::DEPLOY_PROGRAM_ID)]
    pub deploy_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub asset_configuration_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to the hook.
    #[account(address = constants::FACTORY_PROGRAM_ID)]
    pub factory_program: UncheckedAccount<'info>,

    /// CHECK: No address constraint here; the hook's metalist pins the canonical
    /// derivation, and Token-2022 verifies our forwarded extra against it.
    pub asset_class_version_pda: UncheckedAccount<'info>,

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

    /// CHECK: seeds verified; forwarded to the hook (must exist in whitelist mode).
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), destination.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub destination_whitelist_pda: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook (must be empty for the transfer to proceed).
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
