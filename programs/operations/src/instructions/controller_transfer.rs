use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use common::pda_utils;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};
use common::{pda_seeds, require_active, require_functionality, require_role, roles};
use freeze::cpi::accounts::{BlockAccount, UnblockAccount};
use spl_token_2022::{
    extension::StateWithExtensions, instruction::transfer_checked, state::Mint as MintState,
};

use crate::events::ControllerTransferred;
use common::program_ids as constants;

pub fn controller_transfer(ctx: Context<ControllerTransfer>, amount: u64) -> Result<()> {
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_CONTROLLER,
    )?;

    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::OPERATIONS_CONTROLLER_TRANSFER,
    )?;

    let decimals = {
        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        let mint_state =
            StateWithExtensions::<MintState>::unpack(&mint_data).map_err(Error::from)?;
        mint_state.base.decimals
    };

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let permanent_delegate_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::permanent_delegate_seeds(&mint_key),
        &ctx.bumps.operations_authority,
    );

    // ── 1. Unblock source and destination (CPI to freeze) ────────────────────
    freeze::cpi::unblock_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        UnblockAccount {
            calling_authority: ctx.accounts.operations_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.from.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[permanent_delegate_signer_seeds.as_slice()],
    ))?;

    freeze::cpi::unblock_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        UnblockAccount {
            calling_authority: ctx.accounts.operations_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.to.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[permanent_delegate_signer_seeds.as_slice()],
    ))?;

    // ── 2. Transfer via permanent delegate (CPI to Token-2022) ───────────────
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

    // The mint carries the TransferHook extension, so Token-2022 forwards the
    // trailing accounts to the hook. Order is fixed by the metalist built in
    // `transfer-hook::initialize_extra_account_meta_list` (hook indices 4..=9).
    for meta in [
        ctx.accounts.extra_account_meta_list.key(),
        ctx.accounts.transfer_hook_program.key(),
        ctx.accounts.deploy_program.key(),
        ctx.accounts.asset_configuration_pda.key(),
        ctx.accounts.factory_program.key(),
        ctx.accounts.asset_class_version_pda.key(),
        ctx.accounts.instructions_sysvar.key(),
    ] {
        transfer_ix
            .accounts
            .push(AccountMeta::new_readonly(meta, false));
    }

    invoke_signed(
        &transfer_ix,
        &[
            ctx.accounts.from.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.to.to_account_info(),
            ctx.accounts.operations_authority.to_account_info(),
            ctx.accounts.extra_account_meta_list.to_account_info(),
            ctx.accounts.transfer_hook_program.to_account_info(),
            ctx.accounts.deploy_program.to_account_info(),
            ctx.accounts.asset_configuration_pda.to_account_info(),
            ctx.accounts.factory_program.to_account_info(),
            ctx.accounts.asset_class_version_pda.to_account_info(),
            ctx.accounts.instructions_sysvar.to_account_info(),
        ],
        &[permanent_delegate_signer_seeds.as_slice()],
    )?;

    // ── 3. Re-block source and destination (CPI to freeze) ───────────────────
    freeze::cpi::block_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        BlockAccount {
            calling_authority: ctx.accounts.operations_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.from.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[permanent_delegate_signer_seeds.as_slice()],
    ))?;

    freeze::cpi::block_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        BlockAccount {
            calling_authority: ctx.accounts.operations_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.to.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[permanent_delegate_signer_seeds.as_slice()],
    ))?;

    // Emitted last so it only fires when the full transfer succeeds.
    emit_cpi!(ControllerTransferred {
        mint: mint_key,
        controller: ctx.accounts.authority.key(),
        from: ctx.accounts.from.key(),
        to: ctx.accounts.to.key(),
        value: amount,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct ControllerTransfer<'info> {
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

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::FREEZE_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub freeze_authority: UncheckedAccount<'info>,

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

    /// CHECK: Address verified by constraint.
    #[account(address = constants::FREEZE_PROGRAM_ID)]
    pub freeze_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to the hook so its
    /// metalist can resolve `asset_configuration_pda` as an external PDA.
    #[account(address = constants::DEPLOY_PROGRAM_ID)]
    pub deploy_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint; forwarded to the hook so its
    /// metalist can resolve `asset_class_version_pda` as an external PDA.
    #[account(address = constants::FACTORY_PROGRAM_ID)]
    pub factory_program: UncheckedAccount<'info>,

    /// CHECK: Address pinned by constraint and re-verified by the hook's metalist.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

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

    pub token_2022_program: Program<'info, Token2022>,

    /// CHECK: Address verified by seeds/bump; controller bit checked by require_role.
    /// An absent PDA fails at account resolution (AccountOwnedByWrongProgram).
    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,
}
