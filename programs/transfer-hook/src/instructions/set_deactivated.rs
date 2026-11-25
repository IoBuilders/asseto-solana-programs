use anchor_lang::prelude::*;
use common::pda_seeds;
use common::program_ids::DEACTIVATE_PROGRAM_ID;

use crate::state::MintCompliance;

pub fn set_deactivated(ctx: Context<SetDeactivated>) -> Result<()> {
    ctx.accounts.mint_compliance_pda.load_mut()?.deactivated = 1;
    Ok(())
}

#[derive(Accounts)]
pub struct SetDeactivated<'info> {
    #[account(
        seeds = [pda_seeds::REGISTRY_WRITER],
        seeds::program = DEACTIVATE_PROGRAM_ID,
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
