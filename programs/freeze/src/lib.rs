use anchor_lang::prelude::*;
use common::program_ids::{MINT_PROGRAM_ID, OPERATIONS_PROGRAM_ID, TRANSFER_PROGRAM_ID};
use common::{pda_seeds, pda_utils};

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

    pub fn block_account(ctx: Context<BlockAccount>) -> Result<()> {
        block_account::block_account(ctx)
    }

    pub fn unblock_account(ctx: Context<UnblockAccount>) -> Result<()> {
        unblock_account::unblock_account(ctx)
    }

    pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
        freeze_account::freeze_account(ctx)
    }

    pub fn batch_freeze<'info>(ctx: Context<'info, BatchFreezeAccounts<'info>>) -> Result<()> {
        batch_freeze::batch_freeze(ctx)
    }

    pub fn unfreeze_account(ctx: Context<UnfreezeAccount>) -> Result<()> {
        unfreeze_account::unfreeze_account(ctx)
    }

    pub fn partially_freeze_account(
        ctx: Context<PartiallyFreezeAccount>,
        balance: u64,
    ) -> Result<()> {
        partially_freeze_account::partially_freeze_account(ctx, balance)
    }

    pub fn batch_partially_freeze<'info>(
        ctx: Context<'info, BatchPartiallyFreezeAccounts<'info>>,
        balances: Vec<u64>,
    ) -> Result<()> {
        batch_partially_freeze::batch_partially_freeze(ctx, balances)
    }

    pub fn remove_partial_freeze(ctx: Context<RemovePartialFreeze>) -> Result<()> {
        remove_partial_freeze::remove_partial_freeze(ctx)
    }
}

pub(crate) fn assert_authorized_caller(mint_key: &Pubkey, caller: &Pubkey) -> Result<()> {
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
            &pda_seeds::transfer_seeds(mint_key),
            &TRANSFER_PROGRAM_ID
        ),
        ErrorCode::Unauthorized
    );
    Ok(())
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
    use spl_token_2022::extension::StateWithExtensions;
    use spl_token_2022::state::Account as TokenAccountState;

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
