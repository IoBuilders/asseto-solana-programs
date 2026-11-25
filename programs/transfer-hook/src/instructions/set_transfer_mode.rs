use anchor_lang::prelude::*;
use common::pda_seeds;
use common::program_ids::TRANSFER_CONTROL_PROGRAM_ID;
use common::state::{TRANSFER_MODE_BLACKLIST, TRANSFER_MODE_WHITELIST};

use crate::errors::TransferHookError;
use crate::state::MintCompliance;

pub fn set_transfer_mode(ctx: Context<SetTransferMode>, transfer_mode: u8) -> Result<()> {
    require!(
        transfer_mode == TRANSFER_MODE_WHITELIST || transfer_mode == TRANSFER_MODE_BLACKLIST,
        TransferHookError::InvalidTransferMode
    );
    ctx.accounts.mint_compliance_pda.load_mut()?.transfer_mode = transfer_mode;
    Ok(())
}

#[derive(Accounts)]
pub struct SetTransferMode<'info> {
    #[account(
        seeds = [pda_seeds::REGISTRY_WRITER],
        seeds::program = TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub registry_writer: Signer<'info>,

    #[account(
        mut,
        seeds = [pda_seeds::MINT_COMPLIANCE, mint.key().as_ref()],
        bump = mint_compliance_pda.load()?.bump,
    )]
    pub mint_compliance_pda: AccountLoader<'info, MintCompliance>,

    /// CHECK: Seed component only.
    pub mint: UncheckedAccount<'info>,
}
