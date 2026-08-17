use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration};
use common::{pda_seeds, require_active, require_functionality, require_not_paused};

use crate::creation::{record_new_hold, HoldTarget, NewHoldArgs};
use crate::events::HoldCreated;
use crate::state::{Hold, HoldPosition};

pub fn create_hold<'info>(
    ctx: Context<'info, CreateHold<'info>>,
    hold_id: u64,
    amount: u64,
    expiration: i64,
    escrow: Pubkey,
    destination: Option<Pubkey>,
) -> Result<()> {
    require_not_paused(&ctx.accounts.mint.to_account_info())?;
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;
    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::HOLD_CREATE_HOLD,
    )?;
    let target = HoldTarget {
        mint: ctx.accounts.mint.key(),
        token_account: ctx.accounts.token_account.key(),
        balance: ctx.accounts.token_account.amount,
        frozen_pda: &ctx.accounts.token_account_frozen_pda,
        frozen_balance_pda: &ctx.accounts.token_account_frozen_balance_pda,
    };

    record_new_hold(
        target,
        &mut ctx.accounts.hold_position,
        ctx.bumps.hold_position,
        &mut ctx.accounts.hold_record,
        ctx.bumps.hold_record,
        &NewHoldArgs {
            hold_id,
            amount,
            expiration,
            escrow,
            destination,
        },
    )?;

    emit_cpi!(HoldCreated {
        mint: ctx.accounts.mint.key(),
        token_account: ctx.accounts.token_account.key(),
        hold_id,
        escrow,
        destination,
        amount,
        expiration,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(hold_id: u64)]
pub struct CreateHold<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub authority: Signer<'info>,

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
        token::mint = mint,
        token::authority = authority,
        token::token_program = token_program,
    )]
    pub token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: seeds verified; emptiness checked by require_unfrozen_account.
    #[account(
        seeds = [pda_seeds::FROZEN_ACCOUNT, mint.key().as_ref(), token_account.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub token_account_frozen_pda: UncheckedAccount<'info>,

    /// CHECK: seeds verified; may be empty (no partial freeze). Balance read in the handler.
    #[account(
        seeds = [pda_seeds::FROZEN_BALANCE, mint.key().as_ref(), token_account.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub token_account_frozen_balance_pda: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = HoldPosition::DISCRIMINATOR.len() + HoldPosition::INIT_SPACE,
        seeds = [pda_seeds::HOLD_POSITION, mint.key().as_ref(), token_account.key().as_ref()],
        bump,
    )]
    pub hold_position: Box<Account<'info, HoldPosition>>,

    #[account(
        init,
        payer = payer,
        space = Hold::DISCRIMINATOR.len() + Hold::INIT_SPACE,
        seeds = [
            pda_seeds::HOLD,
            mint.key().as_ref(),
            token_account.key().as_ref(),
            &hold_id.to_le_bytes(),
        ],
        bump,
    )]
    pub hold_record: Box<Account<'info, Hold>>,

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

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}
