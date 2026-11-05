use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::load_freeze_state;
declare_id!("8L1kqDvAYC9dQXNNNnZbABtRbHGjzoxSgAPzbQZmwmSd");

#[program]
pub mod freeze {
    use super::*;

    pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
        freeze_account::freeze_account(ctx)
    }

    pub fn batch_freeze_account<'info>(
        ctx: Context<'info, BatchFreezeAccount<'info>>,
    ) -> Result<()> {
        batch_freeze_account::batch_freeze_account(ctx)
    }

    pub fn unfreeze_account(ctx: Context<UnfreezeAccount>) -> Result<()> {
        unfreeze_account::unfreeze_account(ctx)
    }

    pub fn batch_unfreeze_account<'info>(
        ctx: Context<'info, BatchUnfreezeAccount<'info>>,
    ) -> Result<()> {
        batch_unfreeze_account::batch_unfreeze_account(ctx)
    }

    pub fn freeze_account_partial(ctx: Context<FreezeAccountPartial>, balance: u64) -> Result<()> {
        freeze_account_partial::freeze_account_partial(ctx, balance)
    }

    pub fn batch_freeze_account_partial<'info>(
        ctx: Context<'info, BatchFreezeAccountPartial<'info>>,
        balances: Vec<u64>,
    ) -> Result<()> {
        batch_freeze_account_partial::batch_freeze_account_partial(ctx, balances)
    }

    pub fn unfreeze_account_partial(ctx: Context<UnfreezeAccountPartial>) -> Result<()> {
        unfreeze_account_partial::unfreeze_account_partial(ctx)
    }

    pub fn batch_unfreeze_account_partial<'info>(
        ctx: Context<'info, BatchUnfreezeAccountPartial<'info>>,
    ) -> Result<()> {
        batch_unfreeze_account_partial::batch_unfreeze_account_partial(ctx)
    }
}

#[derive(Default)]
pub struct FreezeStatus {
    pub fully_frozen: bool,
    pub frozen_balance: u64,
}

pub fn freeze_status<'info>(freeze_state_pda: &'info AccountInfo<'info>) -> Result<FreezeStatus> {
    Ok(match load_freeze_state(freeze_state_pda)? {
        Some(state) => FreezeStatus {
            fully_frozen: state.fully_frozen,
            frozen_balance: state.frozen_balance,
        },
        None => FreezeStatus::default(),
    })
}

pub fn require_unfrozen_account<'info>(freeze_state_pda: &'info AccountInfo<'info>) -> Result<()> {
    require!(
        !freeze_status(freeze_state_pda)?.fully_frozen,
        errors::ErrorCode::AccountFrozen
    );
    Ok(())
}

pub fn frozen_balance<'info>(freeze_state_pda: &'info AccountInfo<'info>) -> Result<u64> {
    Ok(freeze_status(freeze_state_pda)?.frozen_balance)
}

pub fn require_unfrozen_balance<'info>(
    amount: u64,
    token_account: &AccountInfo,
    freeze_state_pda: &'info AccountInfo<'info>,
) -> Result<()> {
    let available = token_balance(token_account)?.saturating_sub(frozen_balance(freeze_state_pda)?);
    require!(
        available >= amount,
        errors::ErrorCode::InsufficientUnfrozenBalance
    );
    Ok(())
}

/// Post-debit variant of [`require_unfrozen_balance`]. See docs/freeze.md.
pub fn require_frozen_balance_covered<'info>(
    token_account: &AccountInfo,
    freeze_state_pda: &'info AccountInfo<'info>,
) -> Result<()> {
    require_locked_balance_covered(token_account, frozen_balance(freeze_state_pda)?)
}

/// Pure comparator: `total_locked` is the caller's own sum of every lien on the
/// account, so `freeze` needs no dependency on the programs owning the others.
pub fn require_locked_balance_covered(
    token_account: &AccountInfo,
    total_locked: u64,
) -> Result<()> {
    require!(
        token_balance(token_account)? >= total_locked,
        errors::ErrorCode::InsufficientUnfrozenBalance
    );
    Ok(())
}

fn token_balance(token_account: &AccountInfo) -> Result<u64> {
    use spl_token_2022_interface::extension::StateWithExtensions;
    use spl_token_2022_interface::state::Account as TokenAccountState;

    let token_data = token_account.try_borrow_data()?;
    let token_state = StateWithExtensions::<TokenAccountState>::unpack(&token_data)
        .map_err(|_| error!(errors::ErrorCode::InsufficientUnfrozenBalance))?;
    Ok(token_state.base.amount)
}
