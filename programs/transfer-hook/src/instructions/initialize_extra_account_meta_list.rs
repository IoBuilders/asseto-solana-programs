use anchor_lang::prelude::*;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::errors::TransferHookError;
use common::pda_seeds;
use common::program_ids::{DEPLOY_PROGRAM_ID, FACTORY_PROGRAM_ID, SNAPSHOT_PROGRAM_ID};
use common::state::asset_configuration::{
    ASSET_CLASS_CONFIG_ID_OFFSET, ASSET_CLASS_VERSION_ID_OFFSET,
};

/// Number of extra account metas produced by `initialize_extra_account_meta_list`.
/// Keep in sync with the `metas` vec length in the handler.
const EXTRA_ACCOUNT_META_COUNT: usize = 11;

pub fn initialize_extra_account_meta_list(
    ctx: Context<InitializeExtraAccountMetaList>,
) -> Result<()> {
    let metas = vec![
        // 5: snapshot program
        ExtraAccountMeta::new_with_pubkey(&SNAPSHOT_PROGRAM_ID, false, false)?,
        // 6: snapshot_counter_pda — seeds ["snapshot_counter", mint@1], program@5
        ExtraAccountMeta::new_external_pda_with_seeds(
            5,
            &[
                Seed::Literal {
                    bytes: pda_seeds::SNAPSHOT_COUNTER.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,
        // 7: sender (source) holder balance snapshot — writable, program@5
        ExtraAccountMeta::new_external_pda_with_seeds(
            5,
            &[
                Seed::Literal {
                    bytes: pda_seeds::SNAPSHOT_HOLDERBALANCE.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 0 },
            ],
            false,
            true,
        )?,
        // 8: receiver (destination) holder balance snapshot — writable, program@5
        ExtraAccountMeta::new_external_pda_with_seeds(
            5,
            &[
                Seed::Literal {
                    bytes: pda_seeds::SNAPSHOT_HOLDERBALANCE.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 2 },
            ],
            false,
            true,
        )?,
        // 9: transfer hook authority (this program's PDA, writable, pays snapshot PDA creation)
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: pda_seeds::TRANSFER_HOOK_AUTHORITY.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            true,
        )?,
        // 10: deploy program — needed to resolve asset_configuration_pda (external PDA @11)
        ExtraAccountMeta::new_with_pubkey(&DEPLOY_PROGRAM_ID, false, false)?,
        // 11: asset_configuration_pda — seeds ["asset_configuration", mint@1], program@10. Read to
        // supply asset_class_config_id / asset_class_version_id for seed 13.
        ExtraAccountMeta::new_external_pda_with_seeds(
            10,
            &[
                Seed::Literal {
                    bytes: pda_seeds::ASSET_CONFIGURATION.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,
        // 12: factory program — needed to resolve asset_class_version_pda (external PDA @13)
        ExtraAccountMeta::new_with_pubkey(&FACTORY_PROGRAM_ID, false, false)?,
        // 13: asset_class_version_pda — seeds ["asset_class_version",
        // asset_configuration_pda@11.asset_class_config_id, asset_configuration_pda@11.asset_class_version_id],
        // program@12.
        ExtraAccountMeta::new_external_pda_with_seeds(
            12,
            &[
                Seed::Literal {
                    bytes: pda_seeds::ASSET_CLASS_VERSION.to_vec(),
                },
                Seed::AccountData {
                    account_index: 11,
                    data_index: ASSET_CLASS_CONFIG_ID_OFFSET,
                    length: 8,
                },
                Seed::AccountData {
                    account_index: 11,
                    data_index: ASSET_CLASS_VERSION_ID_OFFSET,
                    length: 8,
                },
            ],
            false,
            false,
        )?,
        // 14: system program
        ExtraAccountMeta::new_with_pubkey(&system_program::ID, false, false)?,
        // 15: Instructions sysvar — required for the hook's double-introspection
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
