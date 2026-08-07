use anchor_lang::prelude::*;

mod creation;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

pub use common::program_ids::*;

declare_id!("J8iq5Qz8tXLswZBbUFHuJukf3jpwEXLGVpvFoPZb2qY3");

#[program]
pub mod hold {
    use super::*;

    pub fn create_hold<'info>(
        ctx: Context<'info, CreateHold<'info>>,
        hold_id: u64,
        amount: u64,
        expiration: i64,
        escrow: Pubkey,
        destination: Option<Pubkey>,
    ) -> Result<()> {
        create_hold::create_hold(ctx, hold_id, amount, expiration, escrow, destination)
    }

    pub fn controller_create_hold<'info>(
        ctx: Context<'info, ControllerCreateHold<'info>>,
        hold_id: u64,
        amount: u64,
        expiration: i64,
        escrow: Pubkey,
        destination: Option<Pubkey>,
    ) -> Result<()> {
        controller_create_hold::controller_create_hold(
            ctx,
            hold_id,
            amount,
            expiration,
            escrow,
            destination,
        )
    }

    pub fn execute_hold<'info>(
        ctx: Context<'info, ExecuteHold<'info>>,
        hold_id: u64,
        amount: u64,
    ) -> Result<()> {
        execute_hold::execute_hold(ctx, hold_id, amount)
    }

    pub fn release_hold(ctx: Context<ReleaseHold>, hold_id: u64, amount: u64) -> Result<()> {
        release_hold::release_hold(ctx, hold_id, amount)
    }

    pub fn reclaim_hold(ctx: Context<ReclaimHold>, hold_id: u64) -> Result<()> {
        reclaim_hold::reclaim_hold(ctx, hold_id)
    }
}

pub fn frozen_balance<'info>(frozen_balance_pda: &'info AccountInfo<'info>) -> Result<u64> {
    if frozen_balance_pda.data_is_empty() {
        return Ok(0);
    }
    Ok(Account::<freeze::state::FrozenBalance>::try_from(frozen_balance_pda)?.balance)
}
