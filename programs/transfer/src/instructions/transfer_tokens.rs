use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token_2022::Token2022;
use common::pda_seeds;
use common::program_ids as constants;
use spl_token_2022_interface::{
    extension::StateWithExtensions, instruction::transfer_checked, state::Mint as MintState,
};

pub fn transfer(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
    // ── Read mint decimals ───────────────────────────────────────────────────
    let decimals = {
        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        let mint_state =
            StateWithExtensions::<MintState>::unpack(&mint_data).map_err(Error::from)?;
        mint_state.base.decimals
    };

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    // ── 2. Transfer ─────────────────────────────────────────────────────────
    let mut transfer_ix = transfer_checked(
        &token_program_id,
        &ctx.accounts.source.key(),
        &mint_key,
        &ctx.accounts.destination.key(),
        &ctx.accounts.source_owner.key(),
        &[],
        amount,
        decimals,
    )?;

    transfer_ix.accounts.push(AccountMeta::new_readonly(
        ctx.accounts.extra_account_meta_list.key(),
        false,
    ));
    transfer_ix.accounts.push(AccountMeta::new_readonly(
        ctx.accounts.transfer_hook_program.key(),
        false,
    ));
    // Extras from the ExtraAccountMetaList (hook indices 5..=9).
    transfer_ix.accounts.push(AccountMeta::new_readonly(
        ctx.accounts.deploy_program.key(),
        false,
    ));
    transfer_ix.accounts.push(AccountMeta::new_readonly(
        ctx.accounts.asset_configuration_pda.key(),
        false,
    ));
    transfer_ix.accounts.push(AccountMeta::new_readonly(
        ctx.accounts.factory_program.key(),
        false,
    ));
    transfer_ix.accounts.push(AccountMeta::new_readonly(
        ctx.accounts.asset_class_version_pda.key(),
        false,
    ));
    transfer_ix.accounts.push(AccountMeta::new_readonly(
        ctx.accounts.instructions_sysvar.key(),
        false,
    ));

    invoke(
        &transfer_ix,
        &[
            ctx.accounts.source.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.source_owner.to_account_info(),
            ctx.accounts.extra_account_meta_list.to_account_info(),
            ctx.accounts.transfer_hook_program.to_account_info(),
            ctx.accounts.deploy_program.to_account_info(),
            ctx.accounts.asset_configuration_pda.to_account_info(),
            ctx.accounts.factory_program.to_account_info(),
            ctx.accounts.asset_class_version_pda.to_account_info(),
            ctx.accounts.instructions_sysvar.to_account_info(),
        ],
    )?;

    Ok(())
}

/// Accounts for `transfer`.
///
/// Order matches `VerifyTransfer` for the first four entries
/// (`source_owner`, `source`, `destination`, `mint`) so the transfer hook can
/// later cross-check both instructions describe the same transfer via
/// `Instructions`-sysvar introspection. The remaining accounts are this
/// instruction's own dependencies (freeze CPI signing) plus the accounts that
/// must be forwarded to the hook (its ExtraAccountMetaList entries).
#[derive(Accounts)]
pub struct TransferTokens<'info> {
    /// 0 — Token holder authorising the transfer.
    /// Token-2022's `transfer_checked` validates that this matches `source.owner`.
    pub source_owner: Signer<'info>,

    /// 1 — Source token account.
    ///
    /// CHECK: Writable; owner verified by Token-2022 during `transfer_checked`.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,

    /// 2 — Destination token account.
    ///
    /// CHECK: Writable; validated by Token-2022 during `transfer_checked`.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    /// 3 — The Token-2022 mint.
    ///
    /// CHECK: Validated by Token-2022 during CPI; decimals read in instruction body.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::EXTRA_ACCOUNT_METAS, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::TRANSFER_HOOK_PROGRAM_ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::DEPLOY_PROGRAM_ID)]
    pub deploy_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub asset_configuration_pda: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::FACTORY_PROGRAM_ID)]
    pub factory_program: UncheckedAccount<'info>,

    /// CHECK: No address constraint here; the hook's metalist pins the canonical
    /// derivation (seeded from `asset_configuration_pda`'s asset class config/version ids),
    /// and Token-2022 verifies our forwarded extras against it.
    pub asset_class_version_pda: UncheckedAccount<'info>,

    /// CHECK: Address pinned by constraint and re-verified by the hook's metalist.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
}
