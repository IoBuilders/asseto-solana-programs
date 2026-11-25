use anchor_lang::prelude::*;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::errors::TransferHookError;
use crate::state::MintCompliance;
use common::pda_seeds;
use common::program_ids::{DEPLOY_PROGRAM_ID, HOLD_PROGRAM_ID};
use common::state::COMPLIANCE_LAYOUT_VERSION;

/// Number of extra account metas produced by `initialize_extra_account_meta_list`.
/// Keep in sync with the `metas` vec length in the handler, and with
/// `common::HOOK_FORWARDED_ACCOUNT_COUNT`, which is this plus the two accounts
/// Token-2022 requires on top (the metalist itself and the hook program).
const EXTRA_ACCOUNT_META_COUNT: usize = 5;

pub fn initialize_extra_account_meta_list(
    ctx: Context<InitializeExtraAccountMetaList>,
    transfer_hook_execute_enabled: bool,
) -> Result<()> {
    let mint = ctx.accounts.mint.key();
    {
        let mut record = ctx.accounts.mint_compliance_pda.load_init()?;
        record.mint = mint;
        record.version = COMPLIANCE_LAYOUT_VERSION;
        record.bump = ctx.bumps.mint_compliance_pda;
        record.transfer_hook_execute_enabled = transfer_hook_execute_enabled as u8;
    }
    let mint_compliance_pda = ctx.accounts.mint_compliance_pda.key();
    let metas = vec![
        ExtraAccountMeta::new_with_pubkey(&mint_compliance_pda, false, false)?,
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: pda_seeds::ACCOUNT_COMPLIANCE.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 0 },
            ],
            false,
            false,
        )?,
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: pda_seeds::ACCOUNT_COMPLIANCE.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 2 },
            ],
            false,
            false,
        )?,
        ExtraAccountMeta::new_with_pubkey(&HOLD_PROGRAM_ID, false, false)?,
        ExtraAccountMeta::new_external_pda_with_seeds(
            8,
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

    #[account(
        init,
        payer = payer,
        space = MintCompliance::SPACE,
        seeds = [pda_seeds::MINT_COMPLIANCE, mint.key().as_ref()],
        bump,
    )]
    pub mint_compliance_pda: AccountLoader<'info, MintCompliance>,

    /// CHECK: Address only — used as a seed component.
    pub mint: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
