use anchor_lang::prelude::*;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::errors::TransferHookError;
use common::pda_seeds;
use common::program_ids::{DEPLOY_PROGRAM_ID, FACTORY_PROGRAM_ID, SNAPSHOT_PROGRAM_ID};
use common::state::mint_owner::{ASSET_CLASS_CONFIG_ID_OFFSET, ASSET_CLASS_VERSION_ID_OFFSET};

/// Number of extra account metas produced by `initialize_extra_account_meta_list`.
/// Keep in sync with the `metas` vec length in the handler.
const EXTRA_ACCOUNT_META_COUNT: usize = 11;

/// Initialises an empty ExtraAccountMetaList PDA for this mint.
///
/// Restricted to CPI from deploy: the caller must pass `mint_owner_pda`
/// as a signer (only deploy can produce that signature via invoke_signed).
///
/// Only the accounts the hook needs for the snapshot CPI are listed. All
/// compliance checks have been moved to `transfer::verify_transfer`,
/// so the previous 10 compliance-related extra metas are no longer needed —
/// keeping the list small is what lets Token-2022's 32 KiB heap fit metalist
/// resolution.
pub fn initialize_extra_account_meta_list(
    ctx: Context<InitializeExtraAccountMetaList>
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
        // 10: deploy program — needed to resolve mint_owner_pda (external PDA @11)
        ExtraAccountMeta::new_with_pubkey(&DEPLOY_PROGRAM_ID, false, false)?,
        // 11: mint_owner_pda — seeds ["mint_owner", mint@1], program@10. Read to
        // supply asset_class_config_id / asset_class_version_id for seed 13.
        ExtraAccountMeta::new_external_pda_with_seeds(
            10,
            &[
                Seed::Literal {
                    bytes: pda_seeds::MINT_OWNER.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,
        // 12: factory program — needed to resolve asset_class_version_pda (external PDA @13)
        ExtraAccountMeta::new_with_pubkey(&FACTORY_PROGRAM_ID, false, false)?,
        // 13: asset_class_version_pda — seeds ["asset_class_version",
        // mint_owner_pda@11.asset_class_config_id, mint_owner_pda@11.asset_class_version_id],
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
    /// Pays for the ExtraAccountMetaList account rent.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The mint owner PDA created by deploy for this mint.
    /// deploy passes this as a signer via invoke_signed to prove the call
    /// originates from deploy_mint — no external wallet can produce this signature.
    ///
    /// CHECK: Signer flag proves origin; seeds verify this is the canonical PDA for this mint.
    #[account(
        signer,
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub mint_owner_pda: UncheckedAccount<'info>,

    /// ExtraAccountMetaList PDA — created and initialised by this instruction.
    /// Seeds match the SPL transfer-hook-interface convention so that Token-2022
    /// can locate and verify the list on every transfer.
    ///
    /// CHECK: Created by this instruction; seeds/bump verified by the constraint.
    #[account(
        init,
        seeds = [pda_seeds::EXTRA_ACCOUNT_METAS, mint.key().as_ref()],
        bump,
        space = ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_META_COUNT).unwrap(),
        payer = payer
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    /// The Token-2022 mint being initialised.
    ///
    /// CHECK: Address only — used as a seed component.
    pub mint: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
