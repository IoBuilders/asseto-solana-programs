use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, Create};

use crate::errors::MintError;

/// Creates `destination` as the Token-2022 associated token account of
/// `destination_owner` for `mint` when it does not exist yet.
///
/// An already-existing `destination` (ATA or not) is left untouched and
/// `destination_owner` is ignored. When `destination` is missing, the ATA
/// program's `create_idempotent` both creates it and checks its address is the
/// owner's ATA for `mint`, so a non-ATA address fails there. `payer` funds rent.
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_destination_ata_if_missing<'info>(
    destination: &AccountInfo<'info>,
    destination_owner: Option<&AccountInfo<'info>>,
    payer: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
) -> Result<()> {
    if !destination.data_is_empty() {
        return Ok(());
    }

    let destination_owner = destination_owner.ok_or(MintError::MissingDestinationOwner)?;

    associated_token::create_idempotent(CpiContext::new(
        associated_token_program.key(),
        Create {
            payer: payer.clone(),
            associated_token: destination.clone(),
            authority: destination_owner.clone(),
            mint: mint.clone(),
            system_program: system_program.clone(),
            token_program: token_program.clone(),
        },
    ))
}
