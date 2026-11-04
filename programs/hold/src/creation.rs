use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::{Hold, HoldPosition, HoldStatus};

pub(crate) struct NewHoldArgs {
    pub hold_id: u64,
    pub amount: u64,
    pub expiration: i64,
    pub escrow: Pubkey,
    pub destination: Option<Pubkey>,
}

pub(crate) struct HoldTarget<'info> {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub balance: u64,
    pub freeze_state_pda: &'info AccountInfo<'info>,
}

pub(crate) fn record_new_hold<'info>(
    target: HoldTarget<'info>,
    position: &mut HoldPosition,
    position_bump: u8,
    hold: &mut Hold,
    hold_bump: u8,
    args: &NewHoldArgs,
) -> Result<()> {
    let freeze_status = freeze::freeze_status(target.freeze_state_pda)?;
    require!(
        !freeze_status.fully_frozen,
        freeze::errors::ErrorCode::AccountFrozen
    );

    require!(args.amount > 0, ErrorCode::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;
    require!(args.expiration > now, ErrorCode::ExpirationInThePast);

    position.mint = target.mint;
    position.token_account = target.token_account;
    position.bump = position_bump;

    let expected_hold_id = position
        .hold_count
        .checked_add(1)
        .ok_or(ErrorCode::HoldIdMismatch)?;
    require!(args.hold_id == expected_hold_id, ErrorCode::HoldIdMismatch);

    let available = target
        .balance
        .saturating_sub(freeze_status.frozen_balance)
        .saturating_sub(position.held_amount);
    require!(
        available >= args.amount,
        ErrorCode::InsufficientAvailableBalance
    );

    position.held_amount = position
        .held_amount
        .checked_add(args.amount)
        .ok_or(ErrorCode::InsufficientAvailableBalance)?;
    position.hold_count = expected_hold_id;

    hold.mint = target.mint;
    hold.token_account = target.token_account;
    hold.hold_id = args.hold_id;
    hold.escrow = args.escrow;
    hold.destination = args.destination;
    hold.initial_amount = args.amount;
    hold.current_amount = args.amount;
    hold.created_at = now;
    hold.expiration = args.expiration;
    hold.status = HoldStatus::Active;
    hold.bump = hold_bump;

    Ok(())
}
