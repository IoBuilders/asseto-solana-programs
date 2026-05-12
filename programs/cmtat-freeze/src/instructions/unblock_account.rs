use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use spl_token_2022::instruction::thaw_account;

/// Thaws `token_account` for the given mint.
///
/// Authorization: `calling_authority` must be one of the three authorised PDAs:
/// - `mint_authority`     (cmtat-mint,       signs when minting tokens)
/// - `permanent_delegate` (cmtat-operations,  signs when burning tokens)
/// - `transfer`           (cmtat-transfer,    signs when transferring tokens)
///
/// Being a Signer via CPI with `invoke_signed` proves the originating program authorized
/// the call; the `assert_authorized_caller` check confirms the key is one of the three
/// expected PDAs.
pub fn unblock_account(ctx: Context<UnblockAccount>) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    // ── Authorization check (OR logic, short-circuit) ──────────────────────
    crate::assert_authorized_caller(&mint_key, ctx.accounts.calling_authority.key)?;

    // ── Freeze via this program's PDA ──────────────────────────────────────
    let seeds: &[&[u8]] = &[
        b"freeze_authority",
        mint_key.as_ref(),
        &[ctx.bumps.freeze_authority],
    ];

    invoke_signed(
        &thaw_account(
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
        &[seeds],
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct UnblockAccount<'info> {
     /// The authority allowed to call this instruction.
    /// Must be either:
    /// - mint_authority PDA (cmtat-mint)
    /// - permanent_delegate PDA (cmtat-operations)
    pub calling_authority: Signer<'info>,

    /// This program's freeze authority PDA — signs the Token-2022 thaw CPI.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [b"freeze_authority", mint.key().as_ref()],
        bump,
    )]
    pub freeze_authority: UncheckedAccount<'info>,

    /// The Token-2022 mint.
    ///
    /// CHECK: Validated by Token-2022 during the thaw CPI.
    pub mint: UncheckedAccount<'info>,

    /// The token account to unblock (thaw).
    ///
    /// CHECK: Writable; validated by Token-2022 during the thaw CPI.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
}
