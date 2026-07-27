use anchor_lang::prelude::*;
use common::program_ids::{
    COUPON_PROGRAM_ID, MINT_PROGRAM_ID, OPERATIONS_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID,
};
use common::{pda_seeds, pda_utils};

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("hgUtrpstViwxutrkoVXwQh3GQC18wHAmuAvYFTNiV2M");

#[program]
pub mod snapshot {
    use super::*;

    pub fn take_snapshot(ctx: Context<TakeSnapshot>, merkle_root: [u8; 32]) -> Result<()> {
        take_snapshot::take_snapshot(ctx, merkle_root)
    }

    pub fn update_holderbalance_snapshot(
        ctx: Context<UpdateHolderBalanceSnapshot>,
        delta: u64,
        increase: bool,
    ) -> Result<()> {
        update_holderbalance_snapshot::update_holderbalance_snapshot(ctx, delta, increase)
    }

    // Just to make SnapshotHistory part of the IDL
    pub fn __idl_expose_snapshot_history(_ctx: Context<__SnapshotHistoryIDL>) -> Result<()> {
        Ok(())
    }
}

pub(crate) fn assert_take_snapshot_authorized_caller(
    mint_key: &Pubkey,
    caller: &Pubkey,
) -> Result<()> {
    use crate::errors::ErrorCode;

    let (expected, _) = Pubkey::find_program_address(
        &[pda_seeds::COUPON_AUTHORITY, mint_key.as_ref()],
        &COUPON_PROGRAM_ID,
    );
    require!(expected == *caller, ErrorCode::Unauthorized);
    Ok(())
}

pub(crate) fn assert_holder_balance_authorized_caller(
    mint_key: &Pubkey,
    caller: &Pubkey,
) -> Result<()> {
    use crate::errors::ErrorCode;

    require!(
        pda_utils::is_caller_pda(
            caller,
            &pda_seeds::mint_authority_seeds(mint_key),
            &MINT_PROGRAM_ID
        ) || pda_utils::is_caller_pda(
            caller,
            &pda_seeds::permanent_delegate_seeds(mint_key),
            &OPERATIONS_PROGRAM_ID
        ) || pda_utils::is_caller_pda(
            caller,
            &pda_seeds::transfer_hook_authority_seeds(mint_key),
            &TRANSFER_HOOK_PROGRAM_ID
        ),
        ErrorCode::Unauthorized
    );
    Ok(())
}
