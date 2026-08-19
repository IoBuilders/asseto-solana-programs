use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use common::state::{AssetClassVersion, AssetConfiguration};
use common::{pda_seeds, pda_utils, HookAccounts};
use spl_token_2022_interface::{
    extension::StateWithExtensions, instruction::transfer_checked, state::Mint as MintState,
};

use crate::errors::OperationsError;
use common::program_ids as constants;

pub fn hold_transfer(ctx: Context<HoldTransfer>, amount: u64) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();

    require!(
        pda_utils::is_caller_pda(
            &ctx.accounts.hold_authority.key(),
            &pda_seeds::hold_authority_seeds(&mint_key),
            &constants::HOLD_PROGRAM_ID,
        ),
        OperationsError::UnauthorizedHoldAuthority
    );

    let decimals = {
        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        let mint_state =
            StateWithExtensions::<MintState>::unpack(&mint_data).map_err(Error::from)?;
        mint_state.base.decimals
    };

    let token_program_id = ctx.accounts.token_2022_program.key();
    let permanent_delegate_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::permanent_delegate_seeds(&mint_key),
        &ctx.bumps.operations_authority,
    );

    let mut transfer_ix = transfer_checked(
        &token_program_id,
        &ctx.accounts.from.key(),
        &mint_key,
        &ctx.accounts.to.key(),
        &ctx.accounts.operations_authority.key(),
        &[],
        amount,
        decimals,
    )
    .map_err(Error::from)?;

    let asset_configuration_info = ctx.accounts.asset_configuration_pda.to_account_info();
    let asset_class_version_info = ctx.accounts.asset_class_version_pda.to_account_info();

    let hook_accounts = HookAccounts {
        extra_account_meta_list: &ctx.accounts.extra_account_meta_list,
        transfer_hook_program: &ctx.accounts.transfer_hook_program,
        deploy_program: &ctx.accounts.deploy_program,
        asset_configuration_pda: &asset_configuration_info,
        factory_program: &ctx.accounts.factory_program,
        asset_class_version_pda: &asset_class_version_info,
        deactivate_program: &ctx.accounts.deactivate_program,
        deactivate_pda: &ctx.accounts.deactivate_pda,
        transfer_control_program: &ctx.accounts.transfer_control_program,
        transfer_control_mode_pda: &ctx.accounts.transfer_control_mode_pda,
        source_whitelist_pda: &ctx.accounts.source_whitelist_pda,
        destination_whitelist_pda: &ctx.accounts.destination_whitelist_pda,
        freeze_program: &ctx.accounts.freeze_program,
        source_frozen_pda: &ctx.accounts.source_frozen_pda,
        source_frozen_balance_pda: &ctx.accounts.source_frozen_balance_pda,
        hold_program: &ctx.accounts.hold_program,
        source_hold_position_pda: &ctx.accounts.source_hold_position_pda,
    };
    hook_accounts.append_metas(&mut transfer_ix);

    let mut infos = vec![
        ctx.accounts.from.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.to.to_account_info(),
        ctx.accounts.operations_authority.to_account_info(),
    ];
    hook_accounts.append_infos(&mut infos);

    invoke_signed(
        &transfer_ix,
        &infos,
        &[permanent_delegate_signer_seeds.as_slice()],
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct HoldTransfer<'info> {
    /// CHECK: Signer flag proves origin; the runtime check above proves this is
    /// `hold`'s authority PDA for this mint, which only `hold` can invoke_signed.
    pub hold_authority: Signer<'info>,

    /// CHECK: Validated by Token-2022 during `transfer_checked`; decimals read in the handler.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Writable; validated by Token-2022 during `transfer_checked`.
    #[account(mut)]
    pub from: UncheckedAccount<'info>,

    /// CHECK: Writable; validated by Token-2022 during `transfer_checked`.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::PERMANENT_DELEGATE, mint.key().as_ref()],
        bump,
    )]
    pub operations_authority: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::EXTRA_ACCOUNT_METAS, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::TRANSFER_HOOK_PROGRAM_ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to the hook.
    #[account(address = constants::DEPLOY_PROGRAM_ID)]
    pub deploy_program: UncheckedAccount<'info>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: Address verified by constraint; forwarded to the hook.
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

    /// CHECK: Address verified by constraint; forwarded to the hook.
    #[account(address = constants::DEACTIVATE_PROGRAM_ID)]
    pub deactivate_program: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to the hook.
    #[account(address = constants::TRANSFER_CONTROL_PROGRAM_ID)]
    pub transfer_control_program: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook. May be empty (no mode active).
    #[account(
        seeds = [pda_seeds::TRANSFER_CONTROL_MODE, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub transfer_control_mode_pda: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook.
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), from.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub source_whitelist_pda: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook.
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), to.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub destination_whitelist_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to the hook.
    #[account(address = constants::FREEZE_PROGRAM_ID)]
    pub freeze_program: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook.
    #[account(
        seeds = [pda_seeds::FROZEN_ACCOUNT, mint.key().as_ref(), from.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_pda: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook. May be empty (no partial freeze).
    #[account(
        seeds = [pda_seeds::FROZEN_BALANCE, mint.key().as_ref(), from.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_balance_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to the hook.
    #[account(address = constants::HOLD_PROGRAM_ID)]
    pub hold_program: UncheckedAccount<'info>,

    /// CHECK: seeds verified; forwarded to the hook. May be empty (no holds ever created).
    #[account(
        seeds = [pda_seeds::HOLD_POSITION, mint.key().as_ref(), from.key().as_ref()],
        seeds::program = constants::HOLD_PROGRAM_ID,
        bump,
    )]
    pub source_hold_position_pda: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
}
