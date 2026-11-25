use anchor_lang::prelude::*;
use common::program_ids::TRANSFER_HOOK_PROGRAM_ID;
use common::{pda_seeds, pda_utils, FreezeStatus};
use transfer_hook::cpi::accounts::SetFreeze;

/// Writes both freeze sides of an `AccountCompliance` through `transfer-hook::set_freeze`,
/// signed by this program's `registry_writer` PDA (the only writer the hook accepts).
pub(crate) struct RegistryWriter<'a, 'info> {
    pub registry_writer: &'a AccountInfo<'info>,
    pub bump: u8,
    pub payer: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
}

impl<'info> RegistryWriter<'_, 'info> {
    pub(crate) fn set_freeze(
        &self,
        token_account: &AccountInfo<'info>,
        account_compliance_pda: &AccountInfo<'info>,
        status: FreezeStatus,
    ) -> Result<()> {
        let signer_seeds =
            pda_utils::build_pda_signer_seeds(pda_seeds::registry_writer_seeds(), &self.bump);
        transfer_hook::cpi::set_freeze(
            CpiContext::new_with_signer(
                TRANSFER_HOOK_PROGRAM_ID,
                SetFreeze {
                    registry_writer: self.registry_writer.clone(),
                    payer: self.payer.clone(),
                    account_compliance_pda: account_compliance_pda.clone(),
                    mint: self.mint.clone(),
                    token_account: token_account.clone(),
                    system_program: self.system_program.clone(),
                },
                &[signer_seeds.as_slice()],
            ),
            status.fully_frozen,
            status.frozen_balance,
        )
    }
}
