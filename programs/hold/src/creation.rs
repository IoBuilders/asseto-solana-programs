use anchor_lang::prelude::*;
use common::verify_whitelist_pda;
use freeze::require_unfrozen_account;
use transfer_control::verify_transfer_control_mode;

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
    pub frozen_pda: &'info AccountInfo<'info>,
    pub frozen_balance_pda: &'info AccountInfo<'info>,
    pub transfer_control_mode_pda: &'info AccountInfo<'info>,
    pub whitelist_pda: &'info AccountInfo<'info>,
    pub destination_whitelist_pda: Option<&'info AccountInfo<'info>>,
}

pub(crate) fn record_new_hold<'info>(
    target: HoldTarget<'info>,
    position: &mut HoldPosition,
    position_bump: u8,
    hold: &mut Hold,
    hold_bump: u8,
    args: &NewHoldArgs,
) -> Result<()> {
    require_unfrozen_account(target.frozen_pda)?;

    let mut whitelist_pdas: Vec<&AccountInfo> = vec![target.whitelist_pda];
    if let Some(destination) = args.destination {
        let destination_whitelist_pda = target
            .destination_whitelist_pda
            .ok_or(ErrorCode::MissingDestinationWhitelist)?;
        verify_whitelist_pda(destination_whitelist_pda, &destination, &target.mint)?;
        whitelist_pdas.push(destination_whitelist_pda);
    }
    verify_transfer_control_mode(target.transfer_control_mode_pda, whitelist_pdas.as_slice())?;

    require!(args.amount > 0, ErrorCode::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;
    require!(args.expiration > now, ErrorCode::ExpirationInThePast);

    position.mint = target.mint;
    position.token_account = target.token_account;
    position.bump = position_bump;

    require!(
        args.hold_id == position.next_hold_id,
        ErrorCode::HoldIdMismatch
    );

    let frozen_balance = crate::frozen_balance(target.frozen_balance_pda)?;
    let available = target
        .balance
        .saturating_sub(frozen_balance)
        .saturating_sub(position.held_amount);
    require!(
        available >= args.amount,
        ErrorCode::InsufficientAvailableBalance
    );

    position.held_amount = position
        .held_amount
        .checked_add(args.amount)
        .ok_or(ErrorCode::InsufficientAvailableBalance)?;
    position.next_hold_id = position
        .next_hold_id
        .checked_add(1)
        .ok_or(ErrorCode::HoldIdMismatch)?;

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
