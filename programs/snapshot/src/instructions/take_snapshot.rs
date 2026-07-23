use crate::errors::ErrorCode;
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use common::pda_seeds;

use crate::events::SnapshotTriggered;
use crate::state::{SnapshotCounter, SnapshotHistory, SnapshotMerkleRoot};

/// Records a snapshot checkpoint for the mint.
///
/// `snapshot_counter` holds the id of the **next** snapshot. The snapshot id is
/// therefore the counter's *current* value (0 for the very first snapshot),
/// used as-is; the counter is incremented afterwards. This "next id" convention
/// is what lets the `snapshot_merkle_root` PDA be created with `#[account(init)]`:
/// its seed reads `snapshot_counter.count` at account resolution — before the
/// handler runs — so Anchor can derive and create it. Anchor's `init` also
/// tolerates an attacker pre-funding the (predictable) PDA address, and its `init`
/// semantics guarantee the account (and thus the root) can be created only once
/// per id — no manual `create_account` needed.
///
/// Auxiliary instruction — only callable via CPI by the `coupon_authority` PDA
/// owned by `coupon` (seeds: `["coupon_authority", mint]`). All
/// pause / deactivate / deployer checks live in `coupon::create_coupon`,
/// the sole entry point that triggers a snapshot.
pub fn take_snapshot(ctx: Context<TakeSnapshot>, merkle_root: [u8; 32]) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();

    crate::assert_take_snapshot_authorized_caller(&mint_key, ctx.accounts.calling_authority.key)?;

    // The snapshot id is the counter's current value (the counter stores the id
    // of the *next* snapshot). It matches the value the `snapshot_merkle_root`
    // seed already read at account resolution.
    let snapshot_id = {
        let counter = &mut ctx.accounts.snapshot_counter;
        let id = counter.count;
        if id == 0 {
            // First snapshot for this mint: record the counter bump once.
            counter.bump = ctx.bumps.snapshot_counter;
        }
        counter.count = id
            .checked_add(1)
            .ok_or(ErrorCode::SnapshotCounterOverflow)?;
        id
    };

    // The PDA was created by Anchor's `init`; just persist its contents.
    let merkle = &mut ctx.accounts.snapshot_merkle_root;
    merkle.bump = ctx.bumps.snapshot_merkle_root;
    merkle.merkle_root = merkle_root;

    emit_cpi!(SnapshotTriggered {
        mint: mint_key,
        snapshot_id,
        merkle_root,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct TakeSnapshot<'info> {
    /// The PDA authorised to call this instruction via CPI — must be
    /// `["coupon_authority", mint]` owned by `coupon`.
    pub calling_authority: Signer<'info>,

    /// Funds the `snapshot_counter` / `snapshot_merkle_root` PDAs. Distinct from
    /// `calling_authority` because the latter is a PDA (signs via
    /// `invoke_signed`) and PDAs cannot pay rent directly.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The Token-2022 mint the snapshot is taken on.
    ///
    /// CHECK: Used only as a seed for `calling_authority`'s PDA derivation.
    pub mint: UncheckedAccount<'info>,

    /// Snapshot counter PDA. Holds the id of the **next** snapshot: created at
    /// `count = 0` on the first call, incremented by one after each snapshot.
    /// Seeds: `["snapshot_counter", mint]`.
    #[account(
        init_if_needed,
        payer = payer,
        space = SnapshotCounter::DISCRIMINATOR.len() + SnapshotCounter::INIT_SPACE,
        seeds = [pda_seeds::SNAPSHOT_COUNTER, mint.key().as_ref()],
        bump,
    )]
    pub snapshot_counter: Account<'info, SnapshotCounter>,

    /// Immutable Merkle-root PDA for the snapshot being taken.
    /// Seeds: `["snapshot_merkle_root", mint, snapshot_id]`, where `snapshot_id`
    /// is `snapshot_counter.count` (the next-id value read here at account
    /// resolution).
    #[account(
        init,
        payer = payer,
        space = SnapshotMerkleRoot::DISCRIMINATOR.len() + SnapshotMerkleRoot::INIT_SPACE,
        seeds = [
            pda_seeds::SNAPSHOT_MERKLE_ROOT,
            mint.key().as_ref(),
            &snapshot_counter.count.to_le_bytes(),
        ],
        bump,
    )]
    pub snapshot_merkle_root: Account<'info, SnapshotMerkleRoot>,

    pub system_program: Program<'info, System>,
}

// Just to make SnapshotHistory part of the IDL. `snapshot_history` is only ever
// an `UncheckedAccount` in real instructions, so without this Anchor would omit
// it from the IDL's `accounts` section. `SnapshotMerkleRoot` is already exposed
// via the typed `Account<..>` in `TakeSnapshot` above, so it needs no help here.
#[derive(Accounts)]
pub struct __SnapshotHistoryIDL<'info> {
    pub snapshot_history: Account<'info, SnapshotHistory>,
}
