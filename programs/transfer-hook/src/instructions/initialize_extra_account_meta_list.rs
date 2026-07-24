use anchor_lang::prelude::*;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::errors::TransferHookError;
use common::pda_seeds;
use common::program_ids::{DEPLOY_PROGRAM_ID, FACTORY_PROGRAM_ID};
use common::state::asset_configuration::{
    ASSET_CLASS_CONFIG_ID_OFFSET, ASSET_CLASS_VERSION_ID_OFFSET,
};

/// Number of extra account metas produced by `initialize_extra_account_meta_list`.
/// Keep in sync with the `metas` vec length in the handler.
const EXTRA_ACCOUNT_META_COUNT: usize = 5;

pub fn initialize_extra_account_meta_list(
    ctx: Context<InitializeExtraAccountMetaList>,
) -> Result<()> {
    let metas = vec![
        // 5: deploy program — needed to resolve asset_configuration_pda (external PDA @6)
        ExtraAccountMeta::new_with_pubkey(&DEPLOY_PROGRAM_ID, false, false)?,
        // 6: asset_configuration_pda — seeds ["asset_configuration", mint@1], program@5. Read to
        // supply asset_class_config_id / asset_class_version_id for seed 8.
        ExtraAccountMeta::new_external_pda_with_seeds(
            5,
            &[
                Seed::Literal {
                    bytes: pda_seeds::ASSET_CONFIGURATION.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,
        // 7: factory program — needed to resolve asset_class_version_pda (external PDA @8)
        ExtraAccountMeta::new_with_pubkey(&FACTORY_PROGRAM_ID, false, false)?,
        // 8: asset_class_version_pda — seeds ["asset_class_version",
        // asset_configuration_pda@6.asset_class_config_id, asset_configuration_pda@6.asset_class_version_id],
        // program@7.
        ExtraAccountMeta::new_external_pda_with_seeds(
            7,
            &[
                Seed::Literal {
                    bytes: pda_seeds::ASSET_CLASS_VERSION.to_vec(),
                },
                Seed::AccountData {
                    account_index: 6,
                    data_index: ASSET_CLASS_CONFIG_ID_OFFSET,
                    length: 8,
                },
                Seed::AccountData {
                    account_index: 6,
                    data_index: ASSET_CLASS_VERSION_ID_OFFSET,
                    length: 8,
                },
            ],
            false,
            false,
        )?,
        // 9: Instructions sysvar — required for the hook's double-introspection
        // check (verifies prior transfer::verify_transfer + current
        // transfer::transfer / token-2022::transfer_checked).
        ExtraAccountMeta::new_with_pubkey(&solana_instructions_sysvar::ID, false, false)?,
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
