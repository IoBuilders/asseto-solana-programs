use anchor_lang::prelude::*;
use common::pda_seeds;
use spl_token_2022::extension::StateWithExtensions;
use spl_token_2022::state::Mint;

use crate::state::SnapshotHistory;

pub fn get_totalsupply_snapshot_at(
    ctx: Context<GetTotalSupplySnapshotAt>,
    snapshot_id: u64,
) -> Result<u64> {
    if !ctx.accounts.total_supply_snapshot.data_is_empty() {
        let history = SnapshotHistory::load(&ctx.accounts.total_supply_snapshot.to_account_info())?;
        if let Some(value) = history.lookup_at_or_above(snapshot_id) {
            return Ok(value);
        }
    }

    let mint_data = ctx.accounts.mint.try_borrow_data()?;
    let mint_state = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    Ok(mint_state.base.supply)
}

#[derive(Accounts)]
pub struct GetTotalSupplySnapshotAt<'info> {
    /// CHECK: Parsed via spl-token-2022 directly; not modified.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; emptiness checked in the handler.
    #[account(
        seeds = [pda_seeds::SNAPSHOT_TOTALSUPPLY, mint.key().as_ref()],
        bump,
    )]
    pub total_supply_snapshot: UncheckedAccount<'info>,
}
