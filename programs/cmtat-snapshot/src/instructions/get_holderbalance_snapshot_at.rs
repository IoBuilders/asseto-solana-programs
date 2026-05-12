use anchor_lang::prelude::*;
use spl_token_2022::extension::StateWithExtensions;
use spl_token_2022::state::Account as TokenAccount;

use crate::errors::ErrorCode;
use crate::state::SnapshotHistory;

/// Returns the holder balance recorded at `snapshot_id` for the given token account.
///
/// If `snapshot_id` is not present in the history, returns the value of the
/// entry with the smallest key strictly greater than `snapshot_id`.  When no
/// higher key exists (or the history has not been created yet), falls back to
/// the token account's current balance.
pub fn get_holderbalance_snapshot_at(
    ctx: Context<GetHolderBalanceSnapshotAt>,
    snapshot_id: u64,
) -> Result<u64> {
    if !ctx.accounts.holder_balance_snapshot.data_is_empty() {
        let history = SnapshotHistory::load(&ctx.accounts.holder_balance_snapshot.to_account_info())?;
        if let Some(value) = history.lookup_at_or_above(snapshot_id) {
            return Ok(value);
        }
    }

    // Fallback: the token account may not exist yet — treat that as a zero balance.
    if ctx.accounts.holder_token_account.data_is_empty() {
        return Ok(0);
    }

    let holder_data = ctx.accounts.holder_token_account.try_borrow_data()?;
    let token_account_state = StateWithExtensions::<TokenAccount>::unpack(&holder_data)?;
    require!(
        token_account_state.base.mint == ctx.accounts.mint.key(),
        ErrorCode::InvalidTokenAccount
    );
    Ok(token_account_state.base.amount)
}

#[derive(Accounts)]
pub struct GetHolderBalanceSnapshotAt<'info> {
    /// The Token-2022 mint — used to validate the token account for the fallback.
    ///
    /// CHECK: Not parsed here; mint membership validated via token account.
    pub mint: UncheckedAccount<'info>,

    /// Holder balance snapshot PDA for this mint and token account.  May not exist.
    /// Seeds: `["snapshot_holderbalance", mint, token_account]`.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked in the handler.
    #[account(
        seeds = [b"snapshot_holderbalance", mint.key().as_ref(), holder_token_account.key().as_ref()],
        bump,
    )]
    pub holder_balance_snapshot: UncheckedAccount<'info>,

    /// CHECK: Mint membership validated in the handler via spl-token-2022 unpack.
    pub holder_token_account: UncheckedAccount<'info>,
}
