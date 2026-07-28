use anchor_lang::prelude::*;
use common::pda_seeds;
use common::program_ids::COUPON_PROGRAM_ID;

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
