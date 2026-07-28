use crate::errors::ErrorCode;
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use common::pda_seeds;

use crate::events::SnapshotTriggered;
use crate::state::{SnapshotCounter, SnapshotMerkleRoot};

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
    pub calling_authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Used only as a seed for `calling_authority`'s PDA derivation.
    pub mint: UncheckedAccount<'info>,

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
