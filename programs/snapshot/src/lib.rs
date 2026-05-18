use anchor_lang::prelude::*;
use common::{pda_seeds, pda_utils};
use common::program_ids::{COUPON_PROGRAM_ID, MINT_PROGRAM_ID, OPERATIONS_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID};

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("hgUtrpstViwxutrkoVXwQh3GQC18wHAmuAvYFTNiV2M");

#[program]
pub mod snapshot {
    use super::*;

    pub fn take_snapshot(ctx: Context<TakeSnapshot>) -> Result<()> {
        take_snapshot::take_snapshot(ctx)
    }

    pub fn update_totalsupply_snapshot(ctx: Context<UpdateTotalSupplySnapshot>) -> Result<()> {
        update_totalsupply_snapshot::update_totalsupply_snapshot(ctx)
    }

    pub fn update_holderbalance_snapshot(
        ctx: Context<UpdateHolderBalanceSnapshot>,
        delta: u64,
        increase: bool,
    ) -> Result<()> {
        update_holderbalance_snapshot::update_holderbalance_snapshot(ctx, delta, increase)
    }

    pub fn get_totalsupply_snapshot_at(
        ctx: Context<GetTotalSupplySnapshotAt>,
        snapshot_id: u64,
    ) -> Result<u64> {
        get_totalsupply_snapshot_at::get_totalsupply_snapshot_at(ctx, snapshot_id)
    }

    pub fn get_holderbalance_snapshot_at(
        ctx: Context<GetHolderBalanceSnapshotAt>,
        snapshot_id: u64,
    ) -> Result<u64> {
        get_holderbalance_snapshot_at::get_holderbalance_snapshot_at(ctx, snapshot_id)
    }

    // Just to make SnapshotHistory part of the IDL
    pub fn __idl_expose_snapshot_history(_ctx: Context<__SnapshotHistoryIDL>) -> Result<()> {
        Ok(())
    }
}

/// Asserts that `caller` is the `coupon_authority` PDA owned by `coupon`
/// (seeds: `["coupon_authority", mint]`). Sole authorised caller of
/// `take_snapshot`.
pub(crate) fn assert_take_snapshot_authorized_caller(mint_key: &Pubkey, caller: &Pubkey) -> Result<()> {
    use crate::errors::ErrorCode;

    let (expected, _) = Pubkey::find_program_address(
        &[pda_seeds::COUPON_AUTHORITY, mint_key.as_ref()],
        &COUPON_PROGRAM_ID,
    );
    require!(expected == *caller, ErrorCode::Unauthorized);
    Ok(())
}

/// Asserts that `caller` is one of the three PDAs authorised to call
/// `update_totalsupply_snapshot`:
///   - `mint_authority`     (mint,       seeds: `["mint_authority",     mint]`)
///   - `permanent_delegate` (operations,  seeds: `["permanent_delegate", mint]`)
pub(crate) fn assert_total_supply_authorized_caller(mint_key: &Pubkey, caller: &Pubkey) -> Result<()> {
    use crate::errors::ErrorCode;

    require!(
        pda_utils::is_caller_pda(caller, &pda_seeds::mint_authority_seeds(mint_key), &MINT_PROGRAM_ID)
        || pda_utils::is_caller_pda(caller, &pda_seeds::permanent_delegate_seeds(mint_key), &OPERATIONS_PROGRAM_ID),
        ErrorCode::Unauthorized
    );
    Ok(())
}

/// Asserts that `caller` is one of the three PDAs authorised to call
/// `update_holderbalance_snapshot`:
///   - `mint_authority`     (mint,       seeds: `["mint_authority",     mint]`)
///   - `permanent_delegate` (operations,  seeds: `["permanent_delegate", mint]`)
///   - `transfer_hook_authority` (transfer,   seeds: `["transfer_hook_authority",           mint]`)
pub(crate) fn assert_holder_balance_authorized_caller(mint_key: &Pubkey, caller: &Pubkey) -> Result<()> {
    use crate::errors::ErrorCode;

    require!(
        pda_utils::is_caller_pda(caller, &pda_seeds::mint_authority_seeds(mint_key), &MINT_PROGRAM_ID)
        || pda_utils::is_caller_pda(caller, &pda_seeds::permanent_delegate_seeds(mint_key), &OPERATIONS_PROGRAM_ID)
        || pda_utils::is_caller_pda(caller, &pda_seeds::transfer_hook_authority_seeds(mint_key), &TRANSFER_HOOK_PROGRAM_ID),
        ErrorCode::Unauthorized
    );
    Ok(())
}
