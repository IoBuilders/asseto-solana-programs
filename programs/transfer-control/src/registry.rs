use anchor_lang::prelude::*;
use common::program_ids::TRANSFER_HOOK_PROGRAM_ID;
use common::{pda_seeds, pda_utils};
use transfer_hook::cpi::accounts::{SetInControlList, SetTransferMode};

/// Writes this program's fields of the hook's compliance records, signed by its
/// `registry_writer` PDA (the only writer the hook accepts for them).
pub(crate) struct RegistryWriter<'a, 'info> {
    pub registry_writer: &'a AccountInfo<'info>,
    pub bump: u8,
    pub mint: &'a AccountInfo<'info>,
}

impl<'info> RegistryWriter<'_, 'info> {
    pub(crate) fn set_transfer_mode(
        &self,
        mint_compliance_pda: &AccountInfo<'info>,
        transfer_mode: u8,
    ) -> Result<()> {
        let signer_seeds =
            pda_utils::build_pda_signer_seeds(pda_seeds::registry_writer_seeds(), &self.bump);
        transfer_hook::cpi::set_transfer_mode(
            CpiContext::new_with_signer(
                TRANSFER_HOOK_PROGRAM_ID,
                SetTransferMode {
                    registry_writer: self.registry_writer.clone(),
                    mint_compliance_pda: mint_compliance_pda.clone(),
                    mint: self.mint.clone(),
                },
                &[signer_seeds.as_slice()],
            ),
            transfer_mode,
        )
    }

    pub(crate) fn set_in_control_list(
        &self,
        payer: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
        token_account: &AccountInfo<'info>,
        account_compliance_pda: &AccountInfo<'info>,
        in_control_list: bool,
    ) -> Result<()> {
        let signer_seeds =
            pda_utils::build_pda_signer_seeds(pda_seeds::registry_writer_seeds(), &self.bump);
        transfer_hook::cpi::set_in_control_list(
            CpiContext::new_with_signer(
                TRANSFER_HOOK_PROGRAM_ID,
                SetInControlList {
                    registry_writer: self.registry_writer.clone(),
                    payer: payer.clone(),
                    account_compliance_pda: account_compliance_pda.clone(),
                    mint: self.mint.clone(),
                    token_account: token_account.clone(),
                    system_program: system_program.clone(),
                },
                &[signer_seeds.as_slice()],
            ),
            in_control_list,
        )
    }
}
