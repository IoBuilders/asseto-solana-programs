use anchor_lang::prelude::*;
use common::{pda_seeds, require_active, verify_whitelist_pda};
use freeze::{require_unfrozen_account, require_unfrozen_balance};
use transfer_control::verify_whitelist;

use crate::errors::TransferError;
use common::program_ids as constants;

pub fn batch_verify_transfer<'info>(
    ctx: Context<'info, BatchVerifyTransfer<'info>>,
    amounts: Vec<u64>,
) -> Result<()> {
    require!(!amounts.is_empty(), TransferError::EmptyBatch);
    require!(
        ctx.remaining_accounts.len() == amounts.len() * 2,
        TransferError::InvalidRemainingAccounts
    );

    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_unfrozen_account(&ctx.accounts.source_frozen_pda.to_account_info())?;

    let mut total: u64 = 0;
    for amount in &amounts {
        total = total
            .checked_add(*amount)
            .ok_or(error!(TransferError::BatchAmountOverflow))?;
    }
    require_unfrozen_balance(
        total,
        &ctx.accounts.source.to_account_info(),
        &ctx.accounts.source_frozen_balance_pda.to_account_info(),
    )?;

    let whitelist_active = !ctx
        .accounts
        .transfer_control_mode_pda
        .to_account_info()
        .data_is_empty();

    if whitelist_active {
        verify_whitelist(&ctx.accounts.source_whitelist_pda.to_account_info())?;
    }

    let mint_key = ctx.accounts.mint.key();

    for i in 0..amounts.len() {
        let destination = &ctx.remaining_accounts[i * 2];
        let destination_whitelist_pda = &ctx.remaining_accounts[i * 2 + 1];

        if whitelist_active {
            verify_whitelist_pda(destination_whitelist_pda, &destination.key(), &mint_key)?;
            verify_whitelist(&destination_whitelist_pda.to_account_info())?;
        }
    }

    Ok(())
}

/// Accounts for `batch_verify_transfer`.
///
/// **Order of accounts is part of this instruction's contract** — the transfer
/// hook reads `source` at index 1 and `mint` at index 2 when introspecting this
/// call as the batch's `N-1` instruction. The per-destination `(destination,
/// destination_whitelist_pda)` pairs are appended as `remaining_accounts`.
#[derive(Accounts)]
pub struct BatchVerifyTransfer<'info> {
    /// 0 — Token holder authorising the batch.
    pub source_owner: Signer<'info>,

    /// 1 — Source token account (shared by every leg).
    /// CHECK: Validated via spl-token-2022 unpack inside `require_unfrozen_balance`.
    pub source: UncheckedAccount<'info>,

    /// 2 — Token-2022 mint.
    /// CHECK: Used as a seed for the whitelist PDAs; not parsed here.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; contents read in whitelist checks.
    #[account(
        seeds = [pda_seeds::TRANSFER_CONTROL_MODE, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub transfer_control_mode_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; existence checked by verify_whitelist.
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), source.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub source_whitelist_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; emptiness checked by require_unfrozen_account.
    #[account(
        seeds = [pda_seeds::FROZEN_ACCOUNT, mint.key().as_ref(), source.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; balance read by require_unfrozen_balance.
    #[account(
        seeds = [pda_seeds::FROZEN_BALANCE, mint.key().as_ref(), source.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_balance_pda: UncheckedAccount<'info>,
}
