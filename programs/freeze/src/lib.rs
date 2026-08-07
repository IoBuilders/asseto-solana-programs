use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::FrozenBalance;
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

pub fn require_unfrozen_account(frozen_account_pda: &AccountInfo) -> Result<()> {
    require!(
        frozen_account_pda.data_is_empty(),
        errors::ErrorCode::AccountFrozen
    );
    Ok(())
}

pub fn require_unfrozen_balance<'info>(
    amount: u64,
    token_account: &AccountInfo,
    frozen_balance_pda: &'info AccountInfo<'info>,
) -> Result<()> {
    use crate::errors::ErrorCode;
    use spl_token_2022_interface::extension::StateWithExtensions;
    use spl_token_2022_interface::state::Account as TokenAccountState;

    // ── Read the current token account balance ────────────────────────────────
    let token_data = token_account.try_borrow_data()?;
    let token_state = StateWithExtensions::<TokenAccountState>::unpack(&token_data)
        .map_err(|_| error!(ErrorCode::InsufficientUnfrozenBalance))?;
    let account_balance = token_state.base.amount;

    // ── Read the frozen balance from the PDA (0 if PDA does not exist) ────────
    let frozen_balance: u64 = if frozen_balance_pda.data_is_empty() {
        0
    } else {
        Account::<FrozenBalance>::try_from(frozen_balance_pda)
            .map_err(|_| error!(ErrorCode::InsufficientUnfrozenBalance))?
            .balance
    };

    // ── Check available balance covers the transfer amount ────────────────────
    // saturating_sub handles frozen_balance > account_balance without underflow.
    let available = account_balance.saturating_sub(frozen_balance);
    require!(available >= amount, ErrorCode::InsufficientUnfrozenBalance);

    Ok(())
}

/// Post-debit variant of [`require_unfrozen_balance`] for the transfer hook
/// (Token-2022 runs it after debiting): asserts `balance_post >= frozen`, which
/// is the pre-debit `available >= amount` restated for the post-debit balance.
/// See docs/freeze.md.
pub fn require_frozen_balance_covered<'info>(
    token_account: &AccountInfo,
    frozen_balance_pda: &'info AccountInfo<'info>,
) -> Result<()> {
    require_locked_balance_covered(token_account, frozen_balance_pda, 0)
}

pub fn require_locked_balance_covered<'info>(
    token_account: &AccountInfo,
    frozen_balance_pda: &'info AccountInfo<'info>,
    additional_locked: u64,
) -> Result<()> {
    use crate::errors::ErrorCode;
    use spl_token_2022_interface::extension::StateWithExtensions;
    use spl_token_2022_interface::state::Account as TokenAccountState;

    let token_data = token_account.try_borrow_data()?;
    let token_state = StateWithExtensions::<TokenAccountState>::unpack(&token_data)
        .map_err(|_| error!(ErrorCode::InsufficientUnfrozenBalance))?;
    let account_balance = token_state.base.amount;

    let frozen_balance: u64 = if frozen_balance_pda.data_is_empty() {
        0
    } else {
        Account::<FrozenBalance>::try_from(frozen_balance_pda)
            .map_err(|_| error!(ErrorCode::InsufficientUnfrozenBalance))?
            .balance
    };

    let total_locked = frozen_balance
        .checked_add(additional_locked)
        .ok_or(ErrorCode::InsufficientUnfrozenBalance)?;

    require!(
        account_balance >= total_locked,
        ErrorCode::InsufficientUnfrozenBalance
    );

    Ok(())
}
