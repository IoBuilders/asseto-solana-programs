use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount};
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration};
use common::{pda_seeds, pda_utils, require_active, require_functionality, require_not_paused};
use freeze::{require_locked_balance_covered, require_unfrozen_account};
use operations::cpi::accounts::HoldTransfer;
use transfer_control::verify_transfer_control_mode;

use crate::errors::ErrorCode;
use crate::events::HoldExecuted;
use crate::state::{Hold, HoldPosition, HoldStatus};

pub fn execute_hold<'info>(
    ctx: Context<'info, ExecuteHold<'info>>,
    _hold_id: u64,
    amount: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.mint.to_account_info())?;
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;
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

    let now = Clock::get()?.unix_timestamp;
    require!(now < hold.expiration, ErrorCode::HoldExpired);

    require!(amount > 0, ErrorCode::ZeroAmount);
    require!(amount <= hold.current_amount, ErrorCode::AmountExceedsHold);

    let destination_key = ctx.accounts.destination_token.key();
    if let Some(pinned) = hold.destination {
        require_keys_eq!(destination_key, pinned, ErrorCode::DestinationMismatch);
    }

    verify_transfer_control_mode(
        &ctx.accounts.transfer_control_mode_pda,
        &[
            &ctx.accounts.source_whitelist_pda,
            &ctx.accounts.destination_whitelist_pda,
        ],
    )?;
    require_unfrozen_account(&ctx.accounts.source_frozen_pda)?;

    let held_after = ctx
        .accounts
        .hold_position
        .held_amount
        .checked_sub(amount)
        .ok_or(ErrorCode::HeldAmountUnderflow)?;

    let source_token_info = ctx.accounts.source_token.to_account_info();
    let total_locked = freeze::frozen_balance(&ctx.accounts.source_frozen_balance_pda)?
        .checked_add(held_after)
        .and_then(|locked| locked.checked_add(amount))
        .ok_or(ErrorCode::HeldAmountUnderflow)?;
    require_locked_balance_covered(&source_token_info, total_locked)?;

    ctx.accounts.hold_position.held_amount = held_after;

    let hold = &mut ctx.accounts.hold_record;
    hold.current_amount = hold
        .current_amount
        .checked_sub(amount)
        .ok_or(ErrorCode::AmountExceedsHold)?;
    if hold.current_amount == 0 {
        hold.status = HoldStatus::Closed;
    }
    let remaining_amount = hold.current_amount;
    let hold_id = hold.hold_id;

    let mint_key = ctx.accounts.mint.key();
    let hold_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::hold_authority_seeds(&mint_key),
        &ctx.bumps.hold_authority,
    );

    operations::cpi::hold_transfer(
        CpiContext::new_with_signer(
            constants::OPERATIONS_PROGRAM_ID,
            HoldTransfer {
                hold_authority: ctx.accounts.hold_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.source_token.to_account_info(),
                to: ctx.accounts.destination_token.to_account_info(),
                operations_authority: ctx.accounts.operations_authority.to_account_info(),
                extra_account_meta_list: ctx.accounts.extra_account_meta_list.to_account_info(),
                transfer_hook_program: ctx.accounts.transfer_hook_program.to_account_info(),
                deploy_program: ctx.accounts.deploy_program.to_account_info(),
                asset_configuration_pda: ctx.accounts.asset_configuration_pda.to_account_info(),
                factory_program: ctx.accounts.factory_program.to_account_info(),
                asset_class_version_pda: ctx.accounts.asset_class_version_pda.to_account_info(),
                deactivate_program: ctx.accounts.deactivate_program.to_account_info(),
                deactivate_pda: ctx.accounts.deactivate_pda.to_account_info(),
                transfer_control_program: ctx.accounts.transfer_control_program.to_account_info(),
                transfer_control_mode_pda: ctx.accounts.transfer_control_mode_pda.to_account_info(),
                source_whitelist_pda: ctx.accounts.source_whitelist_pda.to_account_info(),
                destination_whitelist_pda: ctx.accounts.destination_whitelist_pda.to_account_info(),
                freeze_program: ctx.accounts.freeze_program.to_account_info(),
                source_frozen_pda: ctx.accounts.source_frozen_pda.to_account_info(),
                source_frozen_balance_pda: ctx.accounts.source_frozen_balance_pda.to_account_info(),
                hold_program: ctx.accounts.hold_program.to_account_info(),
                source_hold_position_pda: ctx.accounts.hold_position.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[hold_authority_signer_seeds.as_slice()],
        ),
        amount,
    )?;

    emit_cpi!(HoldExecuted {
        mint: mint_key,
        token_account: ctx.accounts.source_token.key(),
        hold_id,
        escrow: ctx.accounts.escrow.key(),
        destination: destination_key,
        amount,
        remaining_amount,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(hold_id: u64)]
pub struct ExecuteHold<'info> {
    pub escrow: Signer<'info>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_2022_program,
    )]
    pub source_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_2022_program,
    )]
    pub destination_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [pda_seeds::HOLD_POSITION, mint.key().as_ref(), source_token.key().as_ref()],
        bump = hold_position.bump,
    )]
    pub hold_position: Box<Account<'info, HoldPosition>>,

    #[account(
        mut,
        seeds = [
            pda_seeds::HOLD,
            mint.key().as_ref(),
            source_token.key().as_ref(),
            &hold_id.to_le_bytes(),
        ],
        bump = hold_record.bump,
    )]
    pub hold_record: Box<Account<'info, Hold>>,

    /// CHECK: PDA address verified by seeds/bump; signs the operations CPI via invoke_signed.
    #[account(
        seeds = [pda_seeds::HOLD_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub hold_authority: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump; the mint's permanent delegate.
    #[account(
        seeds = [pda_seeds::PERMANENT_DELEGATE, mint.key().as_ref()],
        seeds::program = constants::OPERATIONS_PROGRAM_ID,
        bump,
    )]
    pub operations_authority: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; target of the transfer CPI.
    #[account(address = constants::OPERATIONS_PROGRAM_ID)]
    pub operations_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump constraint; forwarded to operations.
    #[account(
        seeds = [pda_seeds::EXTRA_ACCOUNT_METAS, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to operations.
    #[account(address = constants::TRANSFER_HOOK_PROGRAM_ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to operations.
    #[account(address = constants::DEPLOY_PROGRAM_ID)]
    pub deploy_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to operations.
    #[account(address = constants::FACTORY_PROGRAM_ID)]
    pub factory_program: UncheckedAccount<'info>,

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

    /// CHECK: Address verified by constraint; forwarded to operations.
    #[account(address = constants::DEACTIVATE_PROGRAM_ID)]
    pub deactivate_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to operations.
    #[account(address = constants::TRANSFER_CONTROL_PROGRAM_ID)]
    pub transfer_control_program: UncheckedAccount<'info>,

    /// CHECK: seeds verified; read by verify_transfer_control_mode. May be empty.
    #[account(
        seeds = [pda_seeds::TRANSFER_CONTROL_MODE, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub transfer_control_mode_pda: UncheckedAccount<'info>,

    /// CHECK: seeds verified; must exist in whitelist mode.
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), source_token.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub source_whitelist_pda: UncheckedAccount<'info>,

    /// CHECK: seeds verified; must exist in whitelist mode.
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), destination_token.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub destination_whitelist_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to operations.
    #[account(address = constants::FREEZE_PROGRAM_ID)]
    pub freeze_program: UncheckedAccount<'info>,

    /// CHECK: seeds verified; emptiness checked by require_unfrozen_account.
    #[account(
        seeds = [pda_seeds::FROZEN_ACCOUNT, mint.key().as_ref(), source_token.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_pda: UncheckedAccount<'info>,

    /// CHECK: seeds verified; balance read by require_locked_balance_covered. May be empty.
    #[account(
        seeds = [pda_seeds::FROZEN_BALANCE, mint.key().as_ref(), source_token.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_balance_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to operations for the metalist.
    #[account(address = constants::HOLD_PROGRAM_ID)]
    pub hold_program: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
}
