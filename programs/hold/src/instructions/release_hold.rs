use anchor_lang::prelude::*;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration};
use common::{pda_seeds, require_functionality};

use crate::errors::ErrorCode;
use crate::events::HoldReleased;
use crate::state::{Hold, HoldPosition, HoldStatus};

pub fn release_hold(ctx: Context<ReleaseHold>, _hold_id: u64, amount: u64) -> Result<()> {
    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::HOLD_CREATE_HOLD,
    )?;

    let hold = &ctx.accounts.hold_record;
    require_keys_eq!(
        ctx.accounts.escrow.key(),
        hold.escrow,
        ErrorCode::NotTheEscrow
    );
    require!(hold.status == HoldStatus::Active, ErrorCode::HoldNotActive);
    require!(amount > 0, ErrorCode::ZeroAmount);
    require!(amount <= hold.current_amount, ErrorCode::AmountExceedsHold);

    ctx.accounts.hold_position.held_amount = ctx
        .accounts
        .hold_position
        .held_amount
        .checked_sub(amount)
        .ok_or(ErrorCode::HeldAmountUnderflow)?;

    let hold = &mut ctx.accounts.hold_record;
    hold.current_amount = hold
        .current_amount
        .checked_sub(amount)
        .ok_or(ErrorCode::AmountExceedsHold)?;
    if hold.current_amount == 0 {
        hold.status = HoldStatus::Closed;
    }

    emit_cpi!(HoldReleased {
        mint: hold.mint,
        token_account: hold.token_account,
        hold_id: hold.hold_id,
        escrow: hold.escrow,
        amount,
        remaining_amount: hold.current_amount,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(hold_id: u64)]
pub struct ReleaseHold<'info> {
    pub escrow: Signer<'info>,

    /// CHECK: Address only — seed component; tied to the hold by the
    /// `hold_record` seeds, which no other mint can reproduce.
    pub mint: UncheckedAccount<'info>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    #[account(
        seeds = [
            pda_seeds::ASSET_CLASS_VERSION,
            &asset_configuration_pda.asset_class_config_id.to_le_bytes(),
            &asset_configuration_pda.asset_class_version_id.to_le_bytes()
        ],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    /// CHECK: Address only — seed component; tied to the hold by the `hold_record` seeds.
    pub token_account: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [pda_seeds::HOLD_POSITION, mint.key().as_ref(), token_account.key().as_ref()],
        bump = hold_position.bump,
    )]
    pub hold_position: Box<Account<'info, HoldPosition>>,

    #[account(
        mut,
        seeds = [
            pda_seeds::HOLD,
            mint.key().as_ref(),
            token_account.key().as_ref(),
            &hold_id.to_le_bytes(),
        ],
        bump = hold_record.bump,
    )]
    pub hold_record: Box<Account<'info, Hold>>,
}
