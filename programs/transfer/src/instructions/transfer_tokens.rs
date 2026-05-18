use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token_2022::Token2022;
use spl_token_2022::{
    extension::StateWithExtensions,
    instruction::transfer_checked,
    state::Mint as MintState,
};
use freeze::cpi::accounts::{BlockAccount, UnblockAccount};
use common::{pda_utils, pda_seeds};
use common::program_ids as constants;

/// Transfers `amount` tokens from `source` to `destination`.
///
/// Operational instruction — called by the token holder who owns `source`.
/// Authorization: `source_owner` must sign; Token-2022's `transfer_checked`
/// enforces that `source.owner == source_owner`. All compliance checks
/// (deactivation, transfer-mode, whitelist, frozen account, frozen balance)
/// now live in `transfer::verify_transfer`, which clients must invoke as
/// the immediately-prior top-level instruction. This instruction is responsible
/// only for the unblock / transfer / re-block sequence and for forwarding the
/// snapshot accounts to the transfer hook.
pub fn transfer(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
    // ── Read mint decimals ───────────────────────────────────────────────────
    let decimals = {
        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        let mint_state = StateWithExtensions::<MintState>::unpack(&mint_data)
            .map_err(Error::from)?;
        mint_state.base.decimals
    };

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let transfer_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::transfer_seeds(&mint_key),
        &ctx.bumps.transfer_authority
    );

    // ── 1. Unblock source and destination (CPI to freeze) ─────────────
    freeze::cpi::unblock_account(
        CpiContext::new_with_signer(
            constants::FREEZE_PROGRAM_ID,
            UnblockAccount {
                calling_authority: ctx.accounts.transfer_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: ctx.accounts.source.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[transfer_authority_signer_seeds.as_slice()],
        ),
    )?;

    freeze::cpi::unblock_account(
        CpiContext::new_with_signer(
            constants::FREEZE_PROGRAM_ID,
            UnblockAccount {
                calling_authority: ctx.accounts.transfer_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: ctx.accounts.destination.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[transfer_authority_signer_seeds.as_slice()],
        ),
    )?;

    // ── 2. Transfer ─────────────────────────────────────────────────────────
    //
    // token_2022::transfer_checked produces only 4 AccountMeta entries.
    // Token-2022 uses instruction.accounts to discover accessible accounts, so
    // the hook program, ExtraAccountMetaList, and every account referenced in
    // the ExtraAccountMetaList must be appended explicitly. The metalist now
    // contains only the 6 snapshot-related extras, matching what
    // `transfer-hook::initialize_extra_account_meta_list` builds.
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
    // Extras from the ExtraAccountMetaList (hook indices 5..=11).
    transfer_ix.accounts.push(AccountMeta::new_readonly(ctx.accounts.snapshot_program.key(), false));
    transfer_ix.accounts.push(AccountMeta::new_readonly(ctx.accounts.snapshot_counter_pda.key(), false));
    transfer_ix.accounts.push(AccountMeta::new(ctx.accounts.sender_snapshot.key(), false));
    transfer_ix.accounts.push(AccountMeta::new(ctx.accounts.receiver_snapshot.key(), false));
    transfer_ix.accounts.push(AccountMeta::new(ctx.accounts.transfer_hook_authority.key(), false));
    transfer_ix.accounts.push(AccountMeta::new_readonly(ctx.accounts.system_program.key(), false));
    transfer_ix.accounts.push(AccountMeta::new_readonly(ctx.accounts.instructions_sysvar.key(), false));

    invoke(
        &transfer_ix,
        &[
            ctx.accounts.source.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.source_owner.to_account_info(),
            ctx.accounts.extra_account_meta_list.to_account_info(),
            ctx.accounts.transfer_hook_program.to_account_info(),
            ctx.accounts.snapshot_program.to_account_info(),
            ctx.accounts.snapshot_counter_pda.to_account_info(),
            ctx.accounts.sender_snapshot.to_account_info(),
            ctx.accounts.receiver_snapshot.to_account_info(),
            ctx.accounts.transfer_hook_authority.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.instructions_sysvar.to_account_info(),
        ],
    )?;

    // ── 3. Re-block source and destination (CPI to freeze) ────────────
    freeze::cpi::block_account(
        CpiContext::new_with_signer(
            constants::FREEZE_PROGRAM_ID,
            BlockAccount {
                calling_authority: ctx.accounts.transfer_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: ctx.accounts.source.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[transfer_authority_signer_seeds.as_slice()],
        ),
    )?;

    freeze::cpi::block_account(
        CpiContext::new_with_signer(
            constants::FREEZE_PROGRAM_ID,
            BlockAccount {
                calling_authority: ctx.accounts.transfer_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: ctx.accounts.destination.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[transfer_authority_signer_seeds.as_slice()],
        ),
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
/// must be forwarded to the hook (snapshot PDAs, etc.).
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

    /// Transfer authority PDA — authorizes freeze/thaw CPIs to freeze.
    /// Seeds: `["transfer", mint]`.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::TRANSFER, mint.key().as_ref()],
        bump,
    )]
    pub transfer_authority: UncheckedAccount<'info>,

    /// Transfer hook authority PDA — owned by `transfer-hook`. Forwarded
    /// to the hook so it can sign the snapshot CPI and pay rent for newly-created
    /// snapshot PDAs.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        mut,
        seeds = [pda_seeds::TRANSFER_HOOK_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump,
    )]
    pub transfer_hook_authority: UncheckedAccount<'info>,

    /// freeze's freeze authority PDA for this mint.
    /// Passed through to freeze for the freeze/thaw CPIs.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::FREEZE_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub freeze_authority: UncheckedAccount<'info>,

    /// ExtraAccountMetaList PDA for the transfer hook.
    /// Must be present so Token-2022 can invoke the hook during transfer_checked.
    ///
    /// CHECK: Address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::EXTRA_ACCOUNT_METAS, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// The transfer hook program — must be present in the transaction so
    /// Token-2022 can invoke it during transfer_checked.
    ///
    /// CHECK: Address verified by constraint.
    #[account(address = constants::TRANSFER_HOOK_PROGRAM_ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::FREEZE_PROGRAM_ID)]
    pub freeze_program: UncheckedAccount<'info>,

    /// snapshot program — forwarded to the hook so it can CPI into
    /// `update_holderbalance_snapshot`.
    ///
    /// CHECK: No address constraint here; the hook's metalist pins the canonical
    /// snapshot program ID, and Token-2022 verifies our forwarded extras against it.
    pub snapshot_program: UncheckedAccount<'info>,

    /// Snapshot counter PDA for this mint — forwarded to the hook.
    ///
    /// CHECK: Address verified by Token-2022 against the metalist's seed-derived entry.
    pub snapshot_counter_pda: UncheckedAccount<'info>,

    /// Sender (source) holder balance snapshot PDA for this mint and source — forwarded to the hook.
    ///
    /// CHECK: Writable; address verified by Token-2022 against the metalist's seed-derived entry.
    #[account(mut)]
    pub sender_snapshot: UncheckedAccount<'info>,

    /// Receiver (destination) holder balance snapshot PDA for this mint and destination — forwarded to the hook.
    ///
    /// CHECK: Writable; address verified by Token-2022 against the metalist's seed-derived entry.
    #[account(mut)]
    pub receiver_snapshot: UncheckedAccount<'info>,

    /// Instructions sysvar — forwarded to the hook so it can introspect the
    /// preceding `verify_transfer` instruction and the current top-level
    /// instruction.
    ///
    /// CHECK: Address pinned by constraint and re-verified by the hook's metalist.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
