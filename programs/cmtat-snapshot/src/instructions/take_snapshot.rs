use anchor_lang::prelude::*;
use cmtat_common::{require_active, verify_deployer, require_not_paused};

use crate::constants;
use crate::state::{ValueSnapshot, SnapshotCounter};


/// Records a snapshot checkpoint for the mint.
///
/// Increments an on-chain counter in `snapshot_counter_pda`. On the first call the
/// PDA is created and the counter is initialised to 1; subsequent calls increment it.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
pub fn take_snapshot(ctx: Context<TakeSnapshot>) -> Result<()> {
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;

    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    let counter = &mut ctx.accounts.snapshot_counter;
    counter.bump = ctx.bumps.snapshot_counter;
    counter.count = counter.count.checked_add(1).unwrap();

    Ok(())
}

#[derive(Accounts)]
pub struct TakeSnapshot<'info> {
    /// The deployer recorded as mint owner — must sign to authorise the snapshot.
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

    /// The Token-2022 mint — must not be paused.
    ///
    /// CHECK: Read-only; pause state validated by verify_unpause.
    pub mint: UncheckedAccount<'info>,

    /// Snapshot counter PDA. Created on the first call; incremented on subsequent calls.
    /// Seeds: `["snapshot_counter", mint]`.
    #[account(
        init_if_needed,
        payer = deployer,
        space = SnapshotCounter::LEN,
        seeds = [b"snapshot_counter", mint.key().as_ref()],
        bump,
    )]
    pub snapshot_counter: Account<'info, SnapshotCounter>,

    pub system_program: Program<'info, System>,
}

// Just to make ValueSnapshot part of the IDL
#[derive(Accounts)]
pub struct __ValueSnapshotIDL<'info> {
    pub value_snapshot: Account<'info, ValueSnapshot>,
}