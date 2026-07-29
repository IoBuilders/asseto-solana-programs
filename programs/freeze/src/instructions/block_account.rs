use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use common::{pda_seeds, pda_utils};
use spl_token_2022_interface::instruction::freeze_account;

pub fn block_account(ctx: Context<BlockAccount>) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    // ── Authorization check (OR logic, short-circuit) ──────────────────────
    crate::assert_authorized_caller(&mint_key, ctx.accounts.calling_authority.key)?;

    // ── Freeze via this program's PDA ──────────────────────────────────────
    let freeze_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::freeze_authority_seeds(&mint_key),
        &ctx.bumps.freeze_authority,
    );

    invoke_signed(
        &freeze_account(
            &token_program_id,
            &ctx.accounts.token_account.key(),
            &mint_key,
            &ctx.accounts.freeze_authority.key(),
            &[],
        )
        .map_err(Error::from)?,
        &[
            ctx.accounts.token_account.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.freeze_authority.to_account_info(),
        ],
        &[freeze_authority_signer_seeds.as_slice()],
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct BlockAccount<'info> {
    pub calling_authority: Signer<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::FREEZE_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub freeze_authority: UncheckedAccount<'info>,

    /// CHECK: Validated by Token-2022 during the freeze CPI.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Writable; validated by Token-2022 during the freeze CPI.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
}
