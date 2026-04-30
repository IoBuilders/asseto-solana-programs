use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use spl_token_2022::instruction::burn as spl_burn;
use cmtat_common::verify_deactivate;
use cmtat_common::verify_deployer;
use cmtat_freeze::cpi::accounts::{BlockAccount, UnblockAccount};
use cmtat_snapshot::cpi::accounts::{UpdateHolderBalanceSnapshot, UpdateTotalSupplySnapshot};

use crate::constants;

/// Burns `amount` tokens from any `token_account` for the given mint.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
/// The operations authority PDA (permanent delegate) executes the burn, allowing the
/// deployer to reduce the balance of any holder without their consent.
///
/// Before burning, records the pre-burn total supply and holder balance into any active
/// snapshot (CPIs to cmtat-snapshot, both signed by `permanent_delegate`).
/// Both CPIs are no-ops when no snapshot has been taken yet.
pub fn burn(ctx: Context<BurnTokens>, amount: u64) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ───────────────────────────
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;

    // ── Verify mint has not been deactivated ─────────────────────────────────
    verify_deactivate(&ctx.accounts.deactivate_pda.to_account_info())?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let operations_authority_seeds: &[&[u8]] = &[
        b"permanent_delegate",
        mint_key.as_ref(),
        &[ctx.bumps.operations_authority],
    ];

    // ── 1. Update total supply snapshot (CPI to cmtat-snapshot) ──────────────
    cmtat_snapshot::cpi::update_totalsupply_snapshot(
        CpiContext::new_with_signer(
            ctx.accounts.snapshot_program.to_account_info(),
            UpdateTotalSupplySnapshot {
                calling_authority: ctx.accounts.operations_authority.to_account_info(),
                payer: ctx.accounts.deployer.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                snapshot_counter: ctx.accounts.snapshot_counter_pda.to_account_info(),
                total_supply_snapshot: ctx.accounts.total_supply_snapshot.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[operations_authority_seeds],
        ),
    )?;

    // ── 2. Update holder balance snapshot (CPI to cmtat-snapshot) ────────────
    cmtat_snapshot::cpi::update_holderbalance_snapshot(
        CpiContext::new_with_signer(
            ctx.accounts.snapshot_program.to_account_info(),
            UpdateHolderBalanceSnapshot {
                calling_authority: ctx.accounts.operations_authority.to_account_info(),
                payer: ctx.accounts.deployer.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                snapshot_counter: ctx.accounts.snapshot_counter_pda.to_account_info(),
                holder_balance_snapshot: ctx.accounts.holder_balance_snapshot.to_account_info(),
                holder_token_account: ctx.accounts.token_account.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[operations_authority_seeds],
        ),
    )?;

    // ── 3. Unblock token_account (CPI to cmtat-freeze) ───────────────────────
    cmtat_freeze::cpi::unblock_account(
        CpiContext::new_with_signer(
            ctx.accounts.block_program.to_account_info(),
            UnblockAccount {
                calling_authority: ctx.accounts.operations_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: ctx.accounts.token_account.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[operations_authority_seeds],
        ),
    )?;

    // ── 4. Burn via permanent delegate ──────────────────────────────────────────
    invoke_signed(
        &spl_burn(
            &token_program_id,
            &ctx.accounts.token_account.key(),
            &mint_key,
            &ctx.accounts.operations_authority.key(),
            &[],
            amount,
        )
        .map_err(anchor_lang::error::Error::from)?,
        &[
            ctx.accounts.token_account.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.operations_authority.to_account_info(),
        ],
        &[operations_authority_seeds],
    )?;

    // ── 5. Re-block token_account (CPI to cmtat-freeze) ──────────────────────
    cmtat_freeze::cpi::block_account(
        CpiContext::new_with_signer(
            ctx.accounts.block_program.to_account_info(),
            BlockAccount {
                calling_authority: ctx.accounts.operations_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: ctx.accounts.token_account.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[operations_authority_seeds],
        ),
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct BurnTokens<'info> {
    /// The deployer recorded as mint owner — must sign to authorise burning;
    /// marked mutable to pay for snapshot PDA creation.
    #[account(mut)]
    pub deployer: Signer<'info>,

    /// PDA created by cmtat-deploy that records the deployer for this mint.
    ///
    /// CHECK: Address verified by seeds/bump; contents Anchor-deserialized by verify_deployer.
    #[account(
        seeds = [b"mint_owner", mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub mint_owner_pda: UncheckedAccount<'info>,

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

    /// The Token-2022 mint to burn tokens from.
    ///
    /// CHECK: Writable; validated by Token-2022 during the burn CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    /// The token account to burn from (any holder's account).
    ///
    /// CHECK: Writable; validated by Token-2022 during the burn CPI.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,

    /// Operations authority PDA — acts as the permanent delegate for this mint.
    /// Seeds: `["permanent_delegate", mint]`.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [b"permanent_delegate", mint.key().as_ref()],
        bump,
    )]
    pub operations_authority: UncheckedAccount<'info>,

    /// cmtat-freeze's freeze authority PDA for this mint.
    /// Passed through to cmtat-freeze for the freeze/thaw CPIs.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [b"freeze_authority", mint.key().as_ref()],
        seeds::program = constants::CMTAT_FREEZE_PROGRAM_ID,
        bump,
    )]
    pub freeze_authority: UncheckedAccount<'info>,

    /// Snapshot counter PDA for this mint — read by cmtat-snapshot to determine
    /// the active snapshot index. May not exist yet (no snapshot taken).
    /// Seeds: `["snapshot_counter", mint]`, owned by `cmtat-snapshot`.
    ///
    /// CHECK: Address verified by seeds/bump; existence and contents checked by cmtat-snapshot.
    #[account(
        seeds = [b"snapshot_counter", mint.key().as_ref()],
        seeds::program = constants::CMTAT_SNAPSHOT_PROGRAM_ID,
        bump,
    )]
    pub snapshot_counter_pda: UncheckedAccount<'info>,

    /// Total supply snapshot PDA for the current snapshot index.
    /// Dynamic address (depends on snapshot count) — verified inside cmtat-snapshot.
    /// Created by cmtat-snapshot if a snapshot is active and not yet recorded.
    ///
    /// CHECK: Writable; address and existence verified inside update_totalsupply_snapshot.
    #[account(mut)]
    pub total_supply_snapshot: UncheckedAccount<'info>,

    /// Holder balance snapshot PDA for the current snapshot index.
    /// Dynamic address (depends on snapshot count) — verified inside cmtat-snapshot.
    /// Created by cmtat-snapshot if a snapshot is active and not yet recorded.
    ///
    /// CHECK: Writable; address and existence verified inside update_holderbalance_snapshot.
    #[account(mut)]
    pub holder_balance_snapshot: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::CMTAT_FREEZE_PROGRAM_ID)]
    pub block_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::CMTAT_SNAPSHOT_PROGRAM_ID)]
    pub snapshot_program: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
