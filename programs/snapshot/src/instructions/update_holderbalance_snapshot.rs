use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use solana_system_interface::instruction as system_instruction;
use common::{pda_seeds, pda_utils};
use spl_token_2022::extension::StateWithExtensions;
use spl_token_2022::state::Account as TokenAccount;

use crate::errors::ErrorCode;
use crate::state::{SnapshotCounter, SnapshotEntry, SnapshotHistory};

/// Records a holder's balance at the current snapshot index.
///
/// The recorded value is the current token-account balance adjusted by `delta`:
/// `balance + delta` when `increase` is true, `balance - delta` otherwise. This
/// lets callers capture a pre-/post-operation balance when Token-2022 has
/// already debited or credited the account by the time the snapshot runs (e.g.,
/// a transfer hook wanting to record the pre-transfer balance).
///
/// The PDA `["snapshot_holderbalance", mint, token_account]` holds a `SnapshotHistory`
/// containing all (snapshotId, balance) pairs recorded so far for that holder.
/// On the first call the account is created; on subsequent calls it is grown by one
/// entry.  Each new entry's key (snapshotId) must be strictly greater than the last
/// recorded key.  Silently succeeds when no snapshot has been taken yet or the entry
/// for the current snapshot already exists (idempotent).
///
/// Auxiliary instruction — only callable via CPI by one of the authorised PDAs:
/// - `mint_authority`        (mint,            seeds: `["mint_authority",        mint]`)
/// - `permanent_delegate`    (operations,      seeds: `["permanent_delegate",    mint]`)
/// - `transfer_hook_authority` (transfer-hook, seeds: `["transfer_hook_authority", mint]`)
pub fn update_holderbalance_snapshot(
    ctx: Context<UpdateHolderBalanceSnapshot>,
    delta: u64,
    increase: bool,
) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();

    // ── Authorization ────────────────────────────────────────────────────────
    crate::assert_holder_balance_authorized_caller(&mint_key, ctx.accounts.calling_authority.key)?;

    // ── If no snapshot has been taken yet, exit silently ─────────────────────
    if ctx.accounts.snapshot_counter.data_is_empty() {
        return Ok(());
    }

    // ── Read the current snapshot count (guaranteed >= 1 when the PDA exists) ─
    let counter_data = ctx.accounts.snapshot_counter.try_borrow_data()?;
    let mut slice: &[u8] = &counter_data;
    let counter = SnapshotCounter::try_deserialize(&mut slice)?;
    let current_snapshot = counter.count;
    drop(counter_data);

    // ── Read current holder balance from the Token-2022 token account ─────────
    let token_account_key = ctx.accounts.holder_token_account.key();
    let holder_data = ctx.accounts.holder_token_account.try_borrow_data()?;
    let token_account_state = StateWithExtensions::<TokenAccount>::unpack(&holder_data)?;
    require!(
        token_account_state.base.mint == mint_key,
        ErrorCode::InvalidTokenAccount
    );
    let balance = token_account_state.base.amount;
    drop(holder_data);

    // ── Apply the caller-supplied adjustment ──────────────────────────────────
    let holder_balance = if increase {
        balance.checked_add(delta).ok_or(ErrorCode::DeltaOverflow)?
    } else {
        balance.checked_sub(delta).ok_or(ErrorCode::DeltaOverflow)?
    };

    // ── PDA address is verified by the `seeds`/`bump` constraint on the account ───
    let bump = ctx.bumps.holder_balance_snapshot;

    // ── Create the PDA on the first call ─────────────────────────────────────
    if ctx.accounts.holder_balance_snapshot.data_is_empty() {
        let space = SnapshotHistory::len_for(1);
        let lamports = Rent::get()?.minimum_balance(space);
        let holder_balance_signer_seeds = pda_utils::build_pda_signer_seeds(
            pda_seeds::snapshot_holderbalance_seeds(&mint_key, &token_account_key),
            &bump
        );
        invoke_signed(
            &system_instruction::create_account(
                &ctx.accounts.payer.key(),
                &ctx.accounts.holder_balance_snapshot.key(),
                lamports,
                space as u64,
                ctx.program_id,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.holder_balance_snapshot.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[holder_balance_signer_seeds.as_slice()],
        )?;

        let history = SnapshotHistory {
            bump,
            entries: vec![SnapshotEntry { key: current_snapshot, value: holder_balance }],
        };
        history.store(&ctx.accounts.holder_balance_snapshot.to_account_info())?;

        return Ok(());
    }

    // ── PDA exists — deserialize and append the new entry ─────────────────────
    // Callers are responsible for ensuring each key is strictly greater than the
    // previously recorded one; no idempotency or ordering check is done here.
    let mut history = SnapshotHistory::load(&ctx.accounts.holder_balance_snapshot.to_account_info())?;
    history.entries.push(SnapshotEntry { key: current_snapshot, value: holder_balance });

    // ── Grow the account to fit the new entry ─────────────────────────────────
    let new_space = SnapshotHistory::len_for(history.entries.len());
    let new_lamports = Rent::get()?.minimum_balance(new_space);
    let current_lamports = ctx.accounts.holder_balance_snapshot.lamports();
    if new_lamports > current_lamports {
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.payer.key(),
                &ctx.accounts.holder_balance_snapshot.key(),
                new_lamports - current_lamports,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.holder_balance_snapshot.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }
    ctx.accounts.holder_balance_snapshot.resize(new_space)?;

    history.store(&ctx.accounts.holder_balance_snapshot.to_account_info())?;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateHolderBalanceSnapshot<'info> {
    /// The authority allowed to call this instruction via CPI.
    /// Must be mint_authority (mint), permanent_delegate (operations),
    /// or transfer_hook_authority (transfer-hook).
    pub calling_authority: Signer<'info>,

    /// Payer for potential account creation or realloc.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The Token-2022 mint.
    ///
    /// CHECK: Not parsed here; mint membership validated via token account.
    pub mint: UncheckedAccount<'info>,

    /// Snapshot counter PDA for this mint. May not exist yet.
    /// Seeds: `["snapshot_counter", mint]`, owned by this program.
    ///
    /// CHECK: Address verified by seeds/bump; existence and contents checked in the handler.
    #[account(
        seeds = [pda_seeds::SNAPSHOT_COUNTER, mint.key().as_ref()],
        bump,
    )]
    pub snapshot_counter: UncheckedAccount<'info>,

    /// Holder balance snapshot PDA for this mint and token account.
    /// Seeds: `["snapshot_holderbalance", mint, token_account]`.
    /// Holds a `SnapshotHistory` with one entry per snapshot taken so far.
    ///
    /// CHECK: Address verified by seeds/bump; created or grown as needed in the handler.
    #[account(
        mut,
        seeds = [pda_seeds::SNAPSHOT_HOLDERBALANCE, mint.key().as_ref(), holder_token_account.key().as_ref()],
        bump,
    )]
    pub holder_balance_snapshot: UncheckedAccount<'info>,

    /// CHECK: Mint membership validated in the handler via spl-token-2022 unpack.
    pub holder_token_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
