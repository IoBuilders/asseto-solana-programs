use anchor_lang::prelude::*;
use common::program_ids::DEPLOY_PROGRAM_ID;
use common::roles::ROLE_ADMIN;
use common::{bitmask, pda_seeds, pda_utils};

use crate::errors::AccessControlError;
use crate::state::Roles;

pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();

    require!(
        pda_utils::is_caller_pda(
            ctx.accounts.temp_mint_authority.key,
            &pda_seeds::temp_mint_authority_seeds(&mint_key),
            &DEPLOY_PROGRAM_ID
        ),
        AccessControlError::Unauthorized
    );

    let mut roles_account = ctx.accounts.roles_pda.load_init()?;

    roles_account.bump = ctx.bumps.roles_pda;

    bitmask::set_bits(&mut roles_account.mask, &[ROLE_ADMIN])
        .map_err(|_| error!(AccessControlError::RoleOutOfBounds))?;

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub temp_mint_authority: Signer<'info>,

    pub account: Signer<'info>,

    /// CHECK: Read-only; used only as a `roles_pda` seed.
    pub mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = Roles::DISCRIMINATOR.len() + std::mem::size_of::<Roles>(),
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), account.key().as_ref()],
        bump,
    )]
    pub roles_pda: AccountLoader<'info, Roles>,

    pub system_program: Program<'info, System>,
}
