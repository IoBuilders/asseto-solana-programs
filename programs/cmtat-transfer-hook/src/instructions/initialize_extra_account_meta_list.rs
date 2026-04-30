use anchor_lang::prelude::*;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta,
    state::ExtraAccountMetaList,
};

use crate::constants;
use crate::errors::TransferHookError;

/// Initialises an empty ExtraAccountMetaList PDA for this mint.
///
/// Restricted to CPI from cmtat-deploy: the caller must pass `mint_owner_pda`
/// as a signer (only cmtat-deploy can produce that signature via invoke_signed).
pub fn initialize_extra_account_meta_list(
    ctx: Context<InitializeExtraAccountMetaList>,
) -> Result<()> {
    let metas = InitializeExtraAccountMetaList::extra_account_metas()?;
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

    /// The mint owner PDA created by cmtat-deploy for this mint.
    /// cmtat-deploy passes this as a signer via invoke_signed to prove the call
    /// originates from deploy_mint — no external wallet can produce this signature.
    ///
    /// CHECK: Signer flag proves origin; seeds verify this is the canonical PDA for this mint.
    #[account(
        signer,
        seeds = [b"mint_owner", mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEPLOY_PROGRAM_ID,
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
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
        space = ExtraAccountMetaList::size_of(
            InitializeExtraAccountMetaList::extra_account_metas()?.len()
        ).unwrap(),
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

impl<'info> InitializeExtraAccountMetaList<'info> {
    pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
        Ok(vec![])
    }
}
