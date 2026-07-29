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

pub fn require_unfrozen_balance(
    amount: u64,
    token_account: &AccountInfo,
    frozen_balance_pda: &AccountInfo,
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
    // try_deserialize checks the discriminator and Borsh-deserializes the struct
    // without the invariant lifetime constraint that Account::try_from requires.
    let frozen_balance: u64 = if frozen_balance_pda.data_is_empty() {
        0
    } else {
        let data = frozen_balance_pda.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        FrozenBalance::try_deserialize(&mut slice)
            .map_err(|_| error!(ErrorCode::InsufficientUnfrozenBalance))?
            .balance
    };

    // ── Check available balance covers the transfer amount ────────────────────
    // saturating_sub handles frozen_balance > account_balance without underflow.
    let available = account_balance.saturating_sub(frozen_balance);
    require!(available >= amount, ErrorCode::InsufficientUnfrozenBalance);

    Ok(())
}
