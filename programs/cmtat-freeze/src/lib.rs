use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::FrozenBalance;

declare_id!("ERyVR64dpCpoEa335A7LfJZnrEUeL7bxgqfqTogXYoAr");

#[program]
pub mod cmtat_freeze {
    use super::*;

    /// Blocks (freezes) a token account.
    /// Only callable via CPI by `mint_authority` (cmtat-mint), `permanent_delegate`
    /// (cmtat-operations), or `transfer` (cmtat-transfer).
    pub fn block_account(ctx: Context<BlockAccount>) -> Result<()> {
        instructions::block_account::block_account(ctx)
    }

    /// Unblocks (thaws) a token account.
    /// Only callable via CPI by `mint_authority` (cmtat-mint), `permanent_delegate`
    /// (cmtat-operations), or `transfer` (cmtat-transfer).
    pub fn unblock_account(ctx: Context<UnblockAccount>) -> Result<()> {
        instructions::unblock_account::unblock_account(ctx)
    }

    /// Freezes a token account at the CMTAT management level by creating a marker PDA.
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
        instructions::freeze_account::freeze_account(ctx)
    }

    /// Unfreezes a token account at the CMTAT management level by closing the marker PDA.
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    pub fn unfreeze_account(ctx: Context<UnfreezeAccount>) -> Result<()> {
        instructions::unfreeze_account::unfreeze_account(ctx)
    }

    /// Records or updates the frozen balance for a token account.
    /// Creates the `frozen_balance_pda` on first call; overwrites `balance` on subsequent calls.
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    pub fn partially_freeze_account(ctx: Context<PartiallyFreezeAccount>, balance: u64) -> Result<()> {
        instructions::partially_freeze_account::partially_freeze_account(ctx, balance)
    }

    /// Removes the frozen balance for a token account by closing the `frozen_balance_pda`.
    /// Rent lamports are returned to the deployer.
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    pub fn remove_partial_freeze(ctx: Context<RemovePartialFreeze>) -> Result<()> {
        instructions::remove_partial_freeze::remove_partial_freeze(ctx)
    }
}

/// Asserts that `caller` is one of the three PDAs authorised to call
/// `block_account` / `unblock_account`:
///   - `mint_authority`      (cmtat-mint,       seeds: `["mint_authority",      mint]`)
///   - `permanent_delegate`  (cmtat-operations,  seeds: `["permanent_delegate",  mint]`)
///   - `transfer`            (cmtat-transfer,    seeds: `["transfer",            mint]`)
///
/// Uses short-circuit `||` so at most one `find_program_address` is performed
/// when the first candidate matches, and at most three in the worst case.
pub(crate) fn assert_authorized_caller(mint_key: &Pubkey, caller: &Pubkey) -> Result<()> {
    use crate::constants::{CMTAT_MINT_PROGRAM_ID, CMTAT_OPERATIONS_PROGRAM_ID, CMTAT_TRANSFER_PROGRAM_ID};
    use crate::errors::ErrorCode;

    let is_pda = |seeds: &[&[u8]], program_id: &Pubkey| -> bool {
        let (pda, _) = Pubkey::find_program_address(seeds, program_id);
        pda == *caller
    };

    require!(
        is_pda(&[b"mint_authority",     mint_key.as_ref()], &CMTAT_MINT_PROGRAM_ID)
        || is_pda(&[b"permanent_delegate", mint_key.as_ref()], &CMTAT_OPERATIONS_PROGRAM_ID)
        || is_pda(&[b"transfer",           mint_key.as_ref()], &CMTAT_TRANSFER_PROGRAM_ID),
        ErrorCode::Unauthorized
    );
    Ok(())
}

/// Checks whether a `frozen_account_pda` (seeds: `["frozen_account", mint, account]`) exists,
/// indicating the account has been fully frozen at the CMTAT management level.
///
/// Returns `Ok(())` if the PDA does not exist (empty data).
/// Returns `Err(CmtatCommonError::AccountFrozen)` if the PDA has been created.
pub fn require_unfrozen_account(frozen_account_pda: &AccountInfo) -> Result<()> {
    require!(frozen_account_pda.data_is_empty(), errors::ErrorCode::AccountFrozen);
    Ok(())
}

/// Checks that the transferable balance of a token account (account balance minus the
/// frozen balance recorded in `frozen_balance_pda`) is sufficient to cover `amount`.
///
/// If `frozen_balance_pda` is empty (no partial freeze set), the frozen balance is 0.
/// If the frozen balance exceeds the current token balance, the available balance is 0.
///
/// Returns `Ok(())` if `account_balance - frozen_balance >= amount`.
/// Returns `Err(CmtatCommonError::InsufficientUnfrozenBalance)` otherwise.
pub fn require_unfrozen_balance(
    amount: u64,
    token_account: &AccountInfo,
    frozen_balance_pda: &AccountInfo,
) -> Result<()> {
    use spl_token_2022::extension::StateWithExtensions;
    use spl_token_2022::state::Account as TokenAccountState;
    use crate::errors::ErrorCode;

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
