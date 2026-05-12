use anchor_lang::prelude::*;
use cmtat_common::{pda_seeds, require_active, verify_deployer};
use cmtat_freeze::{require_unfrozen_account, require_unfrozen_balance};
use cmtat_transfer_control::{get_transfer_mode, verify_whitelist, TransferMode};

use crate::constants;
use crate::errors::CmtatTransferError;

/// Pre-transfer compliance check.
///
/// Runs the full set of CMTAT pre-transfer rules (deactivation, transfer-control
/// mode, whitelist, frozen account, frozen balance) without moving any tokens.
/// Designed to be the immediately-prior top-level instruction before
/// `cmtat-transfer::transfer` in a transaction; the transfer hook then introspects
/// the `Instructions` sysvar to confirm both this call and the transfer call are
/// present, adjacent, and refer to the same source / destination / mint / amount.
///
/// Account ordering is load-bearing: the transfer hook compares accounts at fixed
/// positions across the introspected `verify_transfer` and the actual `transfer`
/// instructions. Indices 0–3 (source_owner, source, destination, mint) MUST match
/// the corresponding positions in `TransferTokens`.
pub fn verify_transfer(ctx: Context<VerifyTransfer>, amount: u64) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();

    // ── Verify mint has not been deactivated ─────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    // ── Transfer control mode check ──────────────────────────────────────
    match get_transfer_mode(&ctx.accounts.transfer_control_mode_pda.to_account_info())? {
        None => {}
        Some(TransferMode::Clearing) => {
            require!(
                ctx.accounts.deployer.is_signer,
                CmtatTransferError::ClearingModeUnauthorized
            );
            verify_deployer(
                &ctx.accounts.mint_owner_pda.to_account_info(),
                &ctx.accounts.deployer.key(),
            )?;
        }
        Some(TransferMode::Whitelist) => {
            verify_whitelist(&ctx.accounts.source_whitelist_pda.to_account_info())?;
            verify_whitelist(&ctx.accounts.destination_whitelist_pda.to_account_info())?;
        }
    }

    // ── Verify source account has not been frozen at CMTAT level ─────────
    require_unfrozen_account(&ctx.accounts.source_frozen_pda.to_account_info())?;

    // ── Verify available (unfrozen) balance covers the transfer amount ───
    require_unfrozen_balance(
        amount,
        &ctx.accounts.source.to_account_info(),
        &ctx.accounts.source_frozen_balance_pda.to_account_info(),
    )?;

    // Silence the unused-variable warning on `mint_key` if no check above uses it.
    let _ = mint_key;
    Ok(())
}

/// Accounts for `verify_transfer`.
///
/// **Order of accounts is part of this instruction's contract** — the transfer
/// hook reads accounts at fixed indices when introspecting this call. Indices
/// 0–3 must match `TransferTokens` exactly so the hook can cross-check the two
/// instructions describe the same transfer.
#[derive(Accounts)]
pub struct VerifyTransfer<'info> {
    /// 0 — Token holder authorising the transfer.
    pub source_owner: Signer<'info>,

    /// 1 — Source token account.
    /// CHECK: Validated via spl-token-2022 unpack inside `require_unfrozen_balance`.
    pub source: UncheckedAccount<'info>,

    /// 2 — Destination token account.
    /// CHECK: Used as a seed for `destination_whitelist_pda`; not parsed here.
    pub destination: UncheckedAccount<'info>,

    /// 3 — Token-2022 mint.
    /// CHECK: Used as a seed and read inside spl-token-2022 unpack helpers.
    pub mint: UncheckedAccount<'info>,

    /// 4 — Deployer. Must sign when the mint is in clearing mode.
    /// CHECK: Signer flag is checked at runtime only when clearing mode is active.
    pub deployer: UncheckedAccount<'info>,

    /// 5 — Mint owner PDA created by cmtat-deploy; consulted by `verify_deployer`.
    /// CHECK: Address verified by seeds/bump; contents Borsh-deserialized in helper.
    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub mint_owner_pda: UncheckedAccount<'info>,

    /// 6 — Deactivation marker PDA (must be empty).
    /// CHECK: Address verified by seeds/bump; emptiness checked in helper.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// 7 — Transfer Control Mode PDA. May be empty (no mode active).
    /// CHECK: Address verified by seeds/bump; contents read in helper.
    #[account(
        seeds = [pda_seeds::TRANSFER_CONTROL_MODE, mint.key().as_ref()],
        seeds::program = constants::CMTAT_TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub transfer_control_mode_pda: UncheckedAccount<'info>,

    /// 8 — Source whitelist PDA (must exist in whitelist mode).
    /// CHECK: Address verified by seeds/bump; existence checked in helper.
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), source.key().as_ref()],
        seeds::program = constants::CMTAT_TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub source_whitelist_pda: UncheckedAccount<'info>,

    /// 9 — Destination whitelist PDA (must exist in whitelist mode).
    /// CHECK: Address verified by seeds/bump; existence checked in helper.
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), destination.key().as_ref()],
        seeds::program = constants::CMTAT_TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub destination_whitelist_pda: UncheckedAccount<'info>,

    /// 10 — Source frozen-account marker PDA (must be empty for transfer to proceed).
    /// CHECK: Address verified by seeds/bump; emptiness checked in helper.
    #[account(
        seeds = [pda_seeds::FROZEN_ACCOUNT, mint.key().as_ref(), source.key().as_ref()],
        seeds::program = constants::CMTAT_FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_pda: UncheckedAccount<'info>,

    /// 11 — Source partial-freeze balance PDA. May be empty (no partial freeze).
    /// CHECK: Address verified by seeds/bump; balance read in helper.
    #[account(
        seeds = [pda_seeds::FROZEN_BALANCE, mint.key().as_ref(), source.key().as_ref()],
        seeds::program = constants::CMTAT_FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_balance_pda: UncheckedAccount<'info>,
}
