use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::state::Factory;

pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
    let factory = &mut ctx.accounts.factory;
    factory.manager = ctx.accounts.manager.key();
    factory.pause = false;
    factory.bump = ctx.bumps.factory;

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub manager: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = Factory::DISCRIMINATOR.len() + Factory::INIT_SPACE,
        seeds = [pda_seeds::FACTORY],
        bump,
    )]
    pub factory: Account<'info, Factory>,

    pub system_program: Program<'info, System>,
}
