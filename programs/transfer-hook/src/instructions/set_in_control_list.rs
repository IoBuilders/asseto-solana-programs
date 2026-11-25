use anchor_lang::prelude::*;
use common::pda_seeds;
use common::program_ids::TRANSFER_CONTROL_PROGRAM_ID;

use crate::state::{load_or_init_account_compliance, AccountCompliance};

pub fn set_in_control_list(ctx: Context<SetInControlList>, in_control_list: bool) -> Result<()> {
    let mut record = load_or_init_account_compliance(
        &ctx.accounts.account_compliance_pda,
        ctx.bumps.account_compliance_pda,
        ctx.accounts.mint.key(),
        ctx.accounts.token_account.key(),
    )?;
    record.in_control_list = in_control_list as u8;
    Ok(())
}

#[derive(Accounts)]
pub struct SetInControlList<'info> {
    #[account(
        seeds = [pda_seeds::REGISTRY_WRITER],
        seeds::program = TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub registry_writer: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = AccountCompliance::SPACE,
        seeds = [pda_seeds::ACCOUNT_COMPLIANCE, mint.key().as_ref(), token_account.key().as_ref()],
        bump,
    )]
    pub account_compliance_pda: AccountLoader<'info, AccountCompliance>,

    /// CHECK: Seed component only.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Seed component only.
    pub token_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
