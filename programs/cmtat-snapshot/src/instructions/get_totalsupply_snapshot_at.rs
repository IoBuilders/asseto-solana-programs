use anchor_lang::prelude::*;
use cmtat_common::pda_seeds;
use spl_token_2022::extension::StateWithExtensions;
use spl_token_2022::state::Mint;

use crate::state::SnapshotHistory;

/// Returns the total supply recorded at `snapshot_id`.
///
/// If `snapshot_id` is not present in the history, returns the value of the
/// entry with the smallest key strictly greater than `snapshot_id`.  When no
/// higher key exists (or the history has not been created yet), falls back to
/// the mint's current total supply.
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
    /// The Token-2022 mint — used for the fallback to current total supply.
    ///
    /// CHECK: Parsed via spl-token-2022 directly; not modified.
    pub mint: UncheckedAccount<'info>,

    /// Total supply snapshot PDA for this mint.  May not exist.
    /// Seeds: `["snapshot_totalsupply", mint]`.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked in the handler.
    #[account(
        seeds = [pda_seeds::SNAPSHOT_TOTALSUPPLY, mint.key().as_ref()],
        bump,
    )]
    pub total_supply_snapshot: UncheckedAccount<'info>,
}
