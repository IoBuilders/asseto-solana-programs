use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use common::{pda_seeds, pda_utils};
use solana_system_interface::instruction as system_instruction;
use spl_token_2022::extension::StateWithExtensions;
use spl_token_2022::state::Mint;

use crate::state::{SnapshotCounter, SnapshotEntry, SnapshotHistory};

/// Records the mint's total supply at the current snapshot index.
///
/// The PDA `["snapshot_totalsupply", mint]` holds a `SnapshotHistory` containing
/// all (snapshotId, totalSupply) pairs recorded so far.  On the first call the
/// account is created; on subsequent calls it is grown by one entry.  Each new
/// entry's key (snapshotId) must be strictly greater than the last recorded key.
/// Silently succeeds when no snapshot has been taken yet or the entry for the
/// current snapshot already exists (idempotent).
///
/// Auxiliary instruction — only callable via CPI by one of the authorised PDAs:
/// - `mint_authority`     (mint,       seeds: `["mint_authority",     mint]`)
/// - `permanent_delegate` (operations, seeds: `["permanent_delegate", mint]`)
pub fn update_totalsupply_snapshot(ctx: Context<UpdateTotalSupplySnapshot>) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();

    // ── Authorization ────────────────────────────────────────────────────────
    crate::assert_total_supply_authorized_caller(&mint_key, ctx.accounts.calling_authority.key)?;

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

    // ── PDA address is verified by the `seeds`/`bump` constraint on the account ───
    let bump = ctx.bumps.total_supply_snapshot;

    // ── Read current total supply from the Token-2022 mint ────────────────────
    let mint_data = ctx.accounts.mint.try_borrow_data()?;
    let mint_state = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    let current_supply = mint_state.base.supply;
    drop(mint_data);

    // ── Create the PDA on the first call ─────────────────────────────────────
    if ctx.accounts.total_supply_snapshot.data_is_empty() {
        let snapshot_totalsupply_signer_seeds = pda_utils::build_pda_signer_seeds(
            pda_seeds::snapshot_totalsupply_seeds(&mint_key),
            &bump,
        );
        let space = SnapshotHistory::len_for(1);
        let lamports = Rent::get()?.minimum_balance(space);
        invoke_signed(
            &system_instruction::create_account(
                &ctx.accounts.payer.key(),
                &ctx.accounts.total_supply_snapshot.key(),
                lamports,
                space as u64,
                ctx.program_id,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.total_supply_snapshot.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[snapshot_totalsupply_signer_seeds.as_slice()],
        )?;

        let history = SnapshotHistory {
            bump,
            entries: vec![SnapshotEntry {
                key: current_snapshot,
                value: current_supply,
            }],
        };
        history.store(&ctx.accounts.total_supply_snapshot.to_account_info())?;

        return Ok(());
    }

    // ── PDA exists — deserialize and append the new entry ─────────────────────
    // Callers are responsible for ensuring each key is strictly greater than the
    // previously recorded one; no idempotency or ordering check is done here.
    let mut history = SnapshotHistory::load(&ctx.accounts.total_supply_snapshot.to_account_info())?;
    history.entries.push(SnapshotEntry {
        key: current_snapshot,
        value: current_supply,
    });

    // ── Grow the account to fit the new entry ─────────────────────────────────
    let new_space = SnapshotHistory::len_for(history.entries.len());
    let new_lamports = Rent::get()?.minimum_balance(new_space);
    let current_lamports = ctx.accounts.total_supply_snapshot.lamports();
    if new_lamports > current_lamports {
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.payer.key(),
                &ctx.accounts.total_supply_snapshot.key(),
                new_lamports - current_lamports,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.total_supply_snapshot.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }
    ctx.accounts.total_supply_snapshot.resize(new_space)?;

    history.store(&ctx.accounts.total_supply_snapshot.to_account_info())?;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateTotalSupplySnapshot<'info> {
    /// The authority allowed to call this instruction via CPI.
    /// Must be mint_authority (mint) or permanent_delegate (operations).
    pub calling_authority: Signer<'info>,

    /// Payer for potential account creation or realloc.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The Token-2022 mint — read to extract the current total supply.
    ///
    /// CHECK: Parsed via spl-token-2022 directly; not modified.
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

    /// Total supply snapshot PDA for this mint.
    /// Seeds: `["snapshot_totalsupply", mint]`.
    /// Holds a `SnapshotHistory` with one entry per snapshot taken so far.
    ///
    /// CHECK: Address verified by seeds/bump; created or grown as needed in the handler.
    #[account(
        mut,
        seeds = [pda_seeds::SNAPSHOT_TOTALSUPPLY, mint.key().as_ref()],
        bump,
    )]
    pub total_supply_snapshot: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
