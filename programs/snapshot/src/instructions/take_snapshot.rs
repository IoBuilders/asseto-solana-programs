use crate::errors::ErrorCode;
use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::events::SnapshotTriggered;
use crate::state::{SnapshotCounter, SnapshotHistory};

/// Records a snapshot checkpoint for the mint.
///
/// On the first call, creates the `snapshot_counter_pda` and initialises its
/// count to 1. On subsequent calls, increments the counter. The snapshot id is
/// therefore always `>= 1` whenever the counter PDA exists.
///
/// Auxiliary instruction — only callable via CPI by the `coupon_authority` PDA
/// owned by `coupon` (seeds: `["coupon_authority", mint]`). All
/// pause / deactivate / deployer checks live in `coupon::create_coupon`,
/// the sole entry point that triggers a snapshot.
pub fn take_snapshot(ctx: Context<TakeSnapshot>) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();

    crate::assert_take_snapshot_authorized_caller(&mint_key, ctx.accounts.calling_authority.key)?;

    let counter = &mut ctx.accounts.snapshot_counter;
    if counter.count == 0 {
        counter.bump = ctx.bumps.snapshot_counter;
        counter.count = 1;
    } else {
        counter.count = counter
            .count
            .checked_add(1)
            .ok_or(ErrorCode::SnapshotCounterOverflow)?;
    }

    emit_cpi!(SnapshotTriggered {
        mint: mint_key,
        snapshot_id: counter.count,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct TakeSnapshot<'info> {
    /// The PDA authorised to call this instruction via CPI — must be
    /// `["coupon_authority", mint]` owned by `coupon`.
    pub calling_authority: Signer<'info>,

    /// Funds the `snapshot_counter` PDA on the first call. Distinct from
    /// `calling_authority` because the latter is a PDA (signs via
    /// `invoke_signed`) and PDAs cannot pay rent directly.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The Token-2022 mint the snapshot is taken on.
    ///
    /// CHECK: Used only as a seed for `calling_authority`'s PDA derivation.
    pub mint: UncheckedAccount<'info>,

    /// Snapshot counter PDA. Created on the first call with count = 1;
    /// incremented on subsequent calls.
    /// Seeds: `["snapshot_counter", mint]`.
    #[account(
        init_if_needed,
        payer = payer,
        space = SnapshotCounter::DISCRIMINATOR.len() + SnapshotCounter::INIT_SPACE,
        seeds = [pda_seeds::SNAPSHOT_COUNTER, mint.key().as_ref()],
        bump,
    )]
    pub snapshot_counter: Account<'info, SnapshotCounter>,

    pub system_program: Program<'info, System>,
}

// Just to make SnapshotHistory part of the IDL
#[derive(Accounts)]
pub struct __SnapshotHistoryIDL<'info> {
    pub snapshot_history: Account<'info, SnapshotHistory>,
}
