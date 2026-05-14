use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta,
    seeds::Seed,
    state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use common::pda_seeds;
use common::program_ids::{DEPLOY_PROGRAM_ID, SNAPSHOT_PROGRAM_ID};
use crate::errors::TransferHookError;

/// Number of extra account metas produced by `initialize_extra_account_meta_list`.
/// Keep in sync with the `metas` vec length in the handler.
const EXTRA_ACCOUNT_META_COUNT: usize = 7;

/// Initialises an empty ExtraAccountMetaList PDA for this mint.
///
/// Restricted to CPI from deploy: the caller must pass `mint_owner_pda`
/// as a signer (only deploy can produce that signature via invoke_signed).
///
/// Only the accounts the hook needs for the snapshot CPI are listed. All
/// compliance checks have been moved to `transfer::verify_transfer`,
/// so the previous 10 compliance-related extra metas are no longer needed —
/// keeping the list small is what lets Token-2022's 32 KiB heap fit metalist
/// resolution. The `deployer` argument is retained for API stability with
/// `deploy` but is no longer baked into the metalist.
pub fn initialize_extra_account_meta_list(
    ctx: Context<InitializeExtraAccountMetaList>,
    deployer: Pubkey,
) -> Result<()> {
    // The deployer pubkey used to be baked into the metalist for the hook's
    // clearing-mode signer check; that check now lives in
    // `transfer::verify_transfer`, so the param is intentionally unused.
    let _ = deployer;

    let metas = vec![
        // 5: snapshot program
        ExtraAccountMeta::new_with_pubkey(&SNAPSHOT_PROGRAM_ID, false, false)?,

        // 6: snapshot_counter_pda — seeds ["snapshot_counter", mint@1], program@5
        ExtraAccountMeta::new_external_pda_with_seeds(
            5,
            &[
                Seed::Literal { bytes: pda_seeds::SNAPSHOT_COUNTER.to_vec() },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,

        // 7: sender (source) holder balance snapshot — writable, program@5
        ExtraAccountMeta::new_external_pda_with_seeds(
            5,
            &[
                Seed::Literal { bytes: pda_seeds::SNAPSHOT_HOLDERBALANCE.to_vec() },
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
                Seed::Literal { bytes: pda_seeds::SNAPSHOT_HOLDERBALANCE.to_vec() },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 2 },
            ],
            false,
            true,
        )?,

        // 9: transfer hook authority (this program's PDA, writable, pays snapshot PDA creation)
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: pda_seeds::TRANSFER_HOOK_AUTHORITY.to_vec() },
                Seed::AccountKey { index: 1 },
            ],
            false,
            true,
        )?,

        // 10: system program
        ExtraAccountMeta::new_with_pubkey(&solana_program::system_program::ID, false, false)?,

        // 11: Instructions sysvar — required for the hook's double-introspection
        // check (verifies prior transfer::verify_transfer + current
        // transfer::transfer / token-2022::transfer_checked).
        ExtraAccountMeta::new_with_pubkey(
            &anchor_lang::solana_program::sysvar::instructions::ID,
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
