use crate::errors::ErrorCode;
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use common::pda_seeds;

use crate::events::SnapshotTriggered;
use crate::state::{SnapshotCounter, SnapshotHistory, SnapshotMerkleRoot};

/// Records a snapshot checkpoint for the mint.
///
/// On the first call, creates the `snapshot_counter` PDA and initialises its
/// count to 1. On subsequent calls, increments the counter. The snapshot id is
/// therefore always `>= 1` whenever the counter PDA exists.
///
/// For every snapshot it also creates an **immutable** `snapshot_merkle_root`
/// PDA at `["snapshot_merkle_root", mint, snapshot_id]` holding the supplied
/// 32-byte Merkle root. Because the snapshot id is only known after the counter
/// is incremented (Anchor resolves accounts before the handler runs), the PDA
/// is created here manually rather than via an `init` constraint. Immutability
/// is enforced by requiring the account to be uninitialized (empty data) before
/// creation — a given snapshot id's root can never be overwritten. Creation
/// goes through `common::create_or_adopt_pda`, which tolerates an attacker
/// pre-funding the (predictable) PDA address to grief `create_account`.
///
/// Auxiliary instruction — only callable via CPI by the `coupon_authority` PDA
/// owned by `coupon` (seeds: `["coupon_authority", mint]`). All
/// pause / deactivate / deployer checks live in `coupon::create_coupon`,
/// the sole entry point that triggers a snapshot.
pub fn take_snapshot(ctx: Context<TakeSnapshot>, merkle_root: [u8; 32]) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();

    crate::assert_take_snapshot_authorized_caller(&mint_key, ctx.accounts.calling_authority.key)?;

    // ── Increment the snapshot counter, deriving the new snapshot id ─────────
    let snapshot_id = {
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
        counter.count
    };

    // ── Create the immutable Merkle-root PDA for this snapshot id ─────────────
    let snapshot_id_bytes = snapshot_id.to_le_bytes();
    let (expected_pda, bump) = Pubkey::find_program_address(
        &[
            pda_seeds::SNAPSHOT_MERKLE_ROOT,
            mint_key.as_ref(),
            &snapshot_id_bytes,
        ],
        ctx.program_id,
    );
    require_keys_eq!(
        ctx.accounts.snapshot_merkle_root.key(),
        expected_pda,
        ErrorCode::InvalidMerkleRootAccount
    );

    // Immutability guard: refuse to write over an already-initialized root.
    // Snapshot ids are strictly increasing so this never trips in normal flow,
    // but it makes "a root can never be reset" explicit and independent of the
    // creation path below.
    require!(
        ctx.accounts.snapshot_merkle_root.data_is_empty(),
        ErrorCode::InvalidMerkleRootAccount
    );

    let space = SnapshotMerkleRoot::DISCRIMINATOR.len() + SnapshotMerkleRoot::INIT_SPACE;
    let signer_seeds: &[&[u8]] = &[
        pda_seeds::SNAPSHOT_MERKLE_ROOT,
        mint_key.as_ref(),
        &snapshot_id_bytes,
        &[bump],
    ];

    // Create-or-adopt: tolerates an attacker pre-funding the predictable PDA
    // address, which would otherwise make a bare `create_account` fail forever
    // and permanently DoS coupon/snapshot creation for this mint.
    common::create_or_adopt_pda(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.snapshot_merkle_root.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        ctx.program_id,
        space,
        signer_seeds,
    )?;

    let record = SnapshotMerkleRoot { bump, merkle_root };
    let mut account_data = ctx.accounts.snapshot_merkle_root.try_borrow_mut_data()?;
    account_data[..8].copy_from_slice(&SnapshotMerkleRoot::DISCRIMINATOR);
    let mut cursor = std::io::Cursor::new(&mut account_data[8..]);
    record.serialize(&mut cursor)?;
    drop(account_data);

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

    /// Immutable Merkle-root PDA for the snapshot being taken.
    /// Seeds: `["snapshot_merkle_root", mint, snapshot_id]`.
    ///
    /// Passed through without a `seeds` constraint because `snapshot_id` is only
    /// known after the counter is incremented in the handler; its address is
    /// derived, verified, and the account is created there via `invoke_signed`.
    ///
    /// CHECK: Address derived + verified in the handler; created via invoke_signed.
    #[account(mut)]
    pub snapshot_merkle_root: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// Just to make SnapshotHistory + SnapshotMerkleRoot part of the IDL.
// `snapshot_merkle_root` is only ever an `UncheckedAccount` in real
// instructions (created manually via invoke_signed), so without this Anchor
// would omit `SnapshotMerkleRoot` from the IDL's `accounts` section and the TS
// client couldn't `program.account.snapshotMerkleRoot.fetch(...)`.
#[derive(Accounts)]
pub struct __SnapshotHistoryIDL<'info> {
    pub snapshot_history: Account<'info, SnapshotHistory>,
    pub snapshot_merkle_root: Account<'info, SnapshotMerkleRoot>,
}
