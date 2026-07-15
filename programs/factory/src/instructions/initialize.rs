use anchor_lang::prelude::*;
use common::pda_seeds;

use crate::state::Factory;

/// Creates the singleton `factory` PDA and records the `manager`.
///
/// The `manager` must sign the transaction, proving control of the account
/// being set as the factory manager. `pause` is initialised to `false`. The
/// `init` constraint makes this fail if the PDA already exists, so the factory
/// can only be initialised once.
pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
    let factory = &mut ctx.accounts.factory;
    factory.manager = ctx.accounts.manager.key();
    factory.pause = false;
    factory.bump = ctx.bumps.factory;

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Pays for the `factory` PDA creation.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Account recorded as the factory manager. Must sign the transaction so
    /// the manager cannot be set to an account the caller does not control.
    pub manager: Signer<'info>,

    /// Singleton factory config PDA. Seeds: `["factory"]`.
    /// `init` fails if the PDA already exists, enforcing single initialization.
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
