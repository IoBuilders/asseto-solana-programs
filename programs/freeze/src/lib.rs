use anchor_lang::prelude::*;
use common::program_ids::{MINT_PROGRAM_ID, OPERATIONS_PROGRAM_ID, TRANSFER_PROGRAM_ID};
use common::{pda_seeds, pda_utils};

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::FrozenBalance;
declare_id!("8L1kqDvAYC9dQXNNNnZbABtRbHGjzoxSgAPzbQZmwmSd");

#[program]
pub mod freeze {
    use super::*;

    /// Blocks (freezes) a token account.
    /// Only callable via CPI by `mint_authority` (mint), `permanent_delegate`
    /// (operations), or `transfer` (transfer).
    pub fn block_account(ctx: Context<BlockAccount>) -> Result<()> {
        block_account::block_account(ctx)
    }

    /// Unblocks (thaws) a token account.
    /// Only callable via CPI by `mint_authority` (mint), `permanent_delegate`
    /// (operations), or `transfer` (transfer).
    pub fn unblock_account(ctx: Context<UnblockAccount>) -> Result<()> {
        unblock_account::unblock_account(ctx)
    }

    /// Freezes a token account at the management level by creating a marker PDA.
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
        freeze_account::freeze_account(ctx)
    }

    /// Unfreezes a token account at the management level by closing the marker PDA.
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    pub fn unfreeze_account(ctx: Context<UnfreezeAccount>) -> Result<()> {
        unfreeze_account::unfreeze_account(ctx)
    }

    /// Records or updates the frozen balance for a token account.
    /// Creates the `frozen_balance_pda` on first call; overwrites `balance` on subsequent calls.
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    pub fn partially_freeze_account(
        ctx: Context<PartiallyFreezeAccount>,
        balance: u64,
    ) -> Result<()> {
        partially_freeze_account::partially_freeze_account(ctx, balance)
    }

    /// Removes the frozen balance for a token account by closing the `frozen_balance_pda`.
    /// Rent lamports are returned to the deployer.
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    pub fn remove_partial_freeze(ctx: Context<RemovePartialFreeze>) -> Result<()> {
        remove_partial_freeze::remove_partial_freeze(ctx)
    }
}

/// Asserts that `caller` is one of the three PDAs authorised to call
/// `block_account` / `unblock_account`:
///   - `mint_authority`      (mint,       seeds: `["mint_authority",      mint]`)
///   - `permanent_delegate`  (operations,  seeds: `["permanent_delegate",  mint]`)
///   - `transfer`            (transfer,    seeds: `["transfer",            mint]`)
///
/// Uses short-circuit `||` so at most one `find_program_address` is performed
/// when the first candidate matches, and at most three in the worst case.
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

/// Checks whether a `frozen_account_pda` (seeds: `["frozen_account", mint, account]`) exists,
/// indicating the account has been fully frozen at the management level.
///
/// Returns `Ok(())` if the PDA does not exist (empty data).
/// Returns `Err(CommonError::AccountFrozen)` if the PDA has been created.
pub fn require_unfrozen_account(frozen_account_pda: &AccountInfo) -> Result<()> {
    require!(
        frozen_account_pda.data_is_empty(),
        errors::ErrorCode::AccountFrozen
    );
    Ok(())
}

/// Checks that the transferable balance of a token account (account balance minus the
/// frozen balance recorded in `frozen_balance_pda`) is sufficient to cover `amount`.
///
/// If `frozen_balance_pda` is empty (no partial freeze set), the frozen balance is 0.
/// If the frozen balance exceeds the current token balance, the available balance is 0.
///
/// Returns `Ok(())` if `account_balance - frozen_balance >= amount`.
/// Returns `Err(CommonError::InsufficientUnfrozenBalance)` otherwise.
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
