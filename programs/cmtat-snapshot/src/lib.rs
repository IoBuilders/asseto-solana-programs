use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("BcuEispMLyXAa44oRbxjgacAJWdEhFXqrBNXQfgHnfWW");

#[program]
pub mod cmtat_snapshot {
    use super::*;

    pub fn take_snapshot(ctx: Context<TakeSnapshot>) -> Result<()> {
        instructions::take_snapshot::take_snapshot(ctx)
    }

    pub fn update_totalsupply_snapshot(ctx: Context<UpdateTotalSupplySnapshot>) -> Result<()> {
        instructions::update_totalsupply_snapshot::update_totalsupply_snapshot(ctx)
    }

    pub fn update_holderbalance_snapshot(
        ctx: Context<UpdateHolderBalanceSnapshot>,
        delta: u64,
        increase: bool,
    ) -> Result<()> {
        instructions::update_holderbalance_snapshot::update_holderbalance_snapshot(ctx, delta, increase)
    }

    pub fn get_totalsupply_snapshot_at(
        ctx: Context<GetTotalSupplySnapshotAt>,
        snapshot_id: u64,
    ) -> Result<u64> {
        instructions::get_totalsupply_snapshot_at::get_totalsupply_snapshot_at(ctx, snapshot_id)
    }

    pub fn get_holderbalance_snapshot_at(
        ctx: Context<GetHolderBalanceSnapshotAt>,
        snapshot_id: u64,
    ) -> Result<u64> {
        instructions::get_holderbalance_snapshot_at::get_holderbalance_snapshot_at(ctx, snapshot_id)
    }

    // Just to make SnapshotHistory part of the IDL
    pub fn __idl_expose_snapshot_history(
        _ctx: Context<__SnapshotHistoryIDL>,
    ) -> Result<()> {
        Ok(())
    }
}

/// Asserts that `caller` is the `coupon_authority` PDA owned by `cmtat-coupon`
/// (seeds: `["coupon_authority", mint]`). Sole authorised caller of
/// `take_snapshot`.
pub(crate) fn assert_take_snapshot_authorized_caller(mint_key: &Pubkey, caller: &Pubkey) -> Result<()> {
    use crate::constants::CMTAT_COUPON_PROGRAM_ID;
    use crate::errors::ErrorCode;

    let (expected, _) = Pubkey::find_program_address(
        &[b"coupon_authority", mint_key.as_ref()],
        &CMTAT_COUPON_PROGRAM_ID,
    );
    require!(expected == *caller, ErrorCode::Unauthorized);
    Ok(())
}

/// Asserts that `caller` is one of the three PDAs authorised to call
/// `update_totalsupply_snapshot`:
///   - `mint_authority`     (cmtat-mint,       seeds: `["mint_authority",     mint]`)
///   - `permanent_delegate` (cmtat-operations,  seeds: `["permanent_delegate", mint]`)
pub(crate) fn assert_total_supply_authorized_caller(mint_key: &Pubkey, caller: &Pubkey) -> Result<()> {
    use crate::constants::{CMTAT_MINT_PROGRAM_ID, CMTAT_OPERATIONS_PROGRAM_ID};
    use crate::errors::ErrorCode;

    let is_pda = |seeds: &[&[u8]], program_id: &Pubkey| -> bool {
        let (pda, _) = Pubkey::find_program_address(seeds, program_id);
        pda == *caller
    };

    require!(
        is_pda(&[b"mint_authority",     mint_key.as_ref()], &CMTAT_MINT_PROGRAM_ID)
        || is_pda(&[b"permanent_delegate", mint_key.as_ref()], &CMTAT_OPERATIONS_PROGRAM_ID),
        ErrorCode::Unauthorized
    );
    Ok(())
}

/// Asserts that `caller` is one of the three PDAs authorised to call
/// `update_holderbalance_snapshot`:
///   - `mint_authority`     (cmtat-mint,       seeds: `["mint_authority",     mint]`)
///   - `permanent_delegate` (cmtat-operations,  seeds: `["permanent_delegate", mint]`)
///   - `transfer`           (cmtat-transfer,   seeds: `["transfer",           mint]`)
pub(crate) fn assert_holder_balance_authorized_caller(mint_key: &Pubkey, caller: &Pubkey) -> Result<()> {
    use crate::constants::{CMTAT_MINT_PROGRAM_ID, CMTAT_OPERATIONS_PROGRAM_ID, CMTAT_TRANSFER_HOOK_PROGRAM_ID};
    use crate::errors::ErrorCode;

    let is_pda = |seeds: &[&[u8]], program_id: &Pubkey| -> bool {
        let (pda, _) = Pubkey::find_program_address(seeds, program_id);
        pda == *caller
    };

    require!(
        is_pda(&[b"mint_authority",     mint_key.as_ref()], &CMTAT_MINT_PROGRAM_ID)
        || is_pda(&[b"permanent_delegate", mint_key.as_ref()], &CMTAT_OPERATIONS_PROGRAM_ID)
        || is_pda(&[b"transfer_hook_authority",           mint_key.as_ref()], &CMTAT_TRANSFER_HOOK_PROGRAM_ID),
        ErrorCode::Unauthorized
    );
    Ok(())
}
