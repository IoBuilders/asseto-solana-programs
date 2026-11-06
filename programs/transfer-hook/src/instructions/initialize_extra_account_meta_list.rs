use anchor_lang::prelude::*;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::errors::TransferHookError;
use common::pda_seeds;
use common::program_ids::{
    DEACTIVATE_PROGRAM_ID, DEPLOY_PROGRAM_ID, FACTORY_PROGRAM_ID, FREEZE_PROGRAM_ID,
    HOLD_PROGRAM_ID, TRANSFER_CONTROL_PROGRAM_ID,
};
use common::state::asset_configuration::{
    ASSET_CLASS_CONFIG_ID_OFFSET, ASSET_CLASS_VERSION_ID_OFFSET,
};

/// Number of extra account metas produced by `initialize_extra_account_meta_list`.
/// Keep in sync with the `metas` vec length in the handler, and with
/// `common::HOOK_FORWARDED_ACCOUNT_COUNT`, which is this plus the two accounts
/// Token-2022 requires on top (the metalist itself and the hook program).
const EXTRA_ACCOUNT_META_COUNT: usize = 12;

pub fn initialize_extra_account_meta_list(
    ctx: Context<InitializeExtraAccountMetaList>,
) -> Result<()> {
    let mint = ctx.accounts.mint.key();
    let (deactivate_pda, _) = Pubkey::find_program_address(
        &[pda_seeds::DEACTIVATE, mint.as_ref()],
        &DEACTIVATE_PROGRAM_ID,
    );
    let (transfer_control_mode_pda, _) = Pubkey::find_program_address(
        &pda_seeds::transfer_control_mode_seeds(&mint),
        &TRANSFER_CONTROL_PROGRAM_ID,
    );

    let metas = vec![
        ExtraAccountMeta::new_with_pubkey(
            &ctx.accounts.asset_configuration_pda.key(),
            false,
            false,
        )?,
        ExtraAccountMeta::new_with_pubkey(&FACTORY_PROGRAM_ID, false, false)?,
        ExtraAccountMeta::new_external_pda_with_seeds(
            6,
            &[
                Seed::Literal {
                    bytes: pda_seeds::ASSET_CLASS_VERSION.to_vec(),
                },
                Seed::AccountData {
                    account_index: 5,
                    data_index: ASSET_CLASS_CONFIG_ID_OFFSET,
                    length: 8,
                },
                Seed::AccountData {
                    account_index: 5,
                    data_index: ASSET_CLASS_VERSION_ID_OFFSET,
                    length: 8,
                },
            ],
            false,
            false,
        )?,
        ExtraAccountMeta::new_with_pubkey(&deactivate_pda, false, false)?,
        ExtraAccountMeta::new_with_pubkey(&TRANSFER_CONTROL_PROGRAM_ID, false, false)?,
        ExtraAccountMeta::new_with_pubkey(&transfer_control_mode_pda, false, false)?,
        ExtraAccountMeta::new_external_pda_with_seeds(
            9,
            &[
                Seed::Literal {
                    bytes: pda_seeds::CONTROL_LIST.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 0 },
            ],
            false,
            false,
        )?,
        ExtraAccountMeta::new_external_pda_with_seeds(
            9,
            &[
                Seed::Literal {
                    bytes: pda_seeds::CONTROL_LIST.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 2 },
            ],
            false,
            false,
        )?,
        ExtraAccountMeta::new_with_pubkey(&FREEZE_PROGRAM_ID, false, false)?,
        ExtraAccountMeta::new_external_pda_with_seeds(
            13,
            &[
                Seed::Literal {
                    bytes: pda_seeds::FREEZE_STATE.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 0 },
            ],
            false,
            false,
        )?,
        ExtraAccountMeta::new_with_pubkey(&HOLD_PROGRAM_ID, false, false)?,
        ExtraAccountMeta::new_external_pda_with_seeds(
            15,
            &[
                Seed::Literal {
                    bytes: pda_seeds::HOLD_POSITION.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 0 },
            ],
            false,
            false,
        )?,
    ];

    let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)
        .map_err(|_| error!(TransferHookError::InvalidAccountSize))?;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Signer flag proves origin; seeds verify this is the canonical PDA for this mint.
    #[account(
        signer,
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub asset_configuration_pda: UncheckedAccount<'info>,

    /// CHECK: Created by this instruction; seeds/bump verified by the constraint.
    #[account(
        init,
        seeds = [pda_seeds::EXTRA_ACCOUNT_METAS, mint.key().as_ref()],
        bump,
        space = ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_META_COUNT).unwrap(),
        payer = payer
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    /// CHECK: Address only — used as a seed component.
    pub mint: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
