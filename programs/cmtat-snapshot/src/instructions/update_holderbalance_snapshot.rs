use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::Discriminator;
use spl_token_2022::extension::StateWithExtensions;
use spl_token_2022::state::Account as TokenAccount;

use crate::errors::ErrorCode;
use crate::state::{SnapshotCounter, ValueSnapshot};

/// Records the mint's holder balance at the current snapshot index.
///
/// Reads `snapshot_counter_pda` to obtain the active snapshot number; silently
/// succeeds if no snapshot has been taken yet (PDA absent). Derives the
/// `holder_balance_snapshot` PDA for that snapshot number; silently succeeds if
/// it already exists (idempotent). Otherwise creates it and stores the current
/// holder balance.
///
/// Auxiliary instruction — only callable via CPI by one of the three authorised PDAs:
/// - `mint_authority`    (cmtat-mint,       seeds: `["mint_authority",     mint]`)
/// - `permanent_delegate` (cmtat-operations, seeds: `["permanent_delegate", mint]`)
/// - `transfer`          (cmtat-transfer,   seeds: `["transfer",           mint]`)
pub fn update_holderbalance_snapshot(ctx: Context<UpdateHolderBalanceSnapshot>) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();

    // ── Authorization ────────────────────────────────────────────────────────
    crate::assert_holder_balance_authorized_caller(&mint_key, ctx.accounts.calling_authority.key)?;

    // ── If no snapshot has been taken yet, exit silently ─────────────────────
    if ctx.accounts.snapshot_counter.data_is_empty() {
        return Ok(());
    }

    // ── Read the current snapshot count ──────────────────────────────────────
    let counter_data = ctx.accounts.snapshot_counter.try_borrow_data()?;
    let mut slice: &[u8] = &counter_data;
    let counter = SnapshotCounter::try_deserialize(&mut slice)?;
    let current_snapshot = counter.count;
    drop(counter_data);

    // ── Derive and verify the total_supply PDA ────────────────────────────────
    let snapshot_bytes = current_snapshot.to_le_bytes();
    let (expected_pda, bump) = Pubkey::find_program_address(
        &[b"snapshot_holderbalance", mint_key.as_ref(), snapshot_bytes.as_ref()],
        ctx.program_id,
    );
    require!(
        ctx.accounts.holder_balance_snapshot.key() == expected_pda,
        ErrorCode::InvalidTotalSupplyPda
    );

    // ── If PDA already holds data, nothing to do ──────────────────────────────
    if !ctx.accounts.holder_balance_snapshot.data_is_empty() {
        return Ok(());
    }

    // ── Read current holder balance from the Token-2022 mint ────────────────────
    let holder_data = ctx.accounts.holder_token_account.try_borrow_data()?;
    let token_account = StateWithExtensions::<TokenAccount>::unpack(&holder_data)?;
    require!(
        token_account.base.mint == mint_key,
        ErrorCode::InvalidTokenAccount
    );
    let holder_balance = token_account.base.amount;

    // ── Create the PDA via system program CPI ─────────────────────────────────
    let lamports = Rent::get()?.minimum_balance(ValueSnapshot::LEN);
    invoke_signed(
        &system_instruction::create_account(
            &ctx.accounts.payer.key(),
            &expected_pda,
            lamports,
            ValueSnapshot::LEN as u64,
            ctx.program_id,
        ),
        &[
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.holder_balance_snapshot.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[&[
            b"snapshot_holderbalance",
            mint_key.as_ref(),
            snapshot_bytes.as_ref(),
            &[bump],
        ]],
    )?;

    // ── Write discriminator + data ────────────────────────────────────────────
    let obj = ValueSnapshot { bump, value: holder_balance };
    let mut account_data = ctx.accounts.holder_balance_snapshot.try_borrow_mut_data()?;
    account_data[..8].copy_from_slice(&ValueSnapshot::DISCRIMINATOR);
    let mut cursor = std::io::Cursor::new(&mut account_data[8..]);
    obj.serialize(&mut cursor)?;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateHolderBalanceSnapshot<'info> {
    /// The authority allowed to call this instruction via CPI.
    /// Must be mint_authority (cmtat-mint), permanent_delegate (cmtat-operations),
    /// or transfer (cmtat-transfer).
    pub calling_authority: Signer<'info>,

    /// Payer for the potential `holder_balance_snapshot` account creation.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The Token-2022 mint — read to extract the current holder balance.
    ///
    /// CHECK: Parsed via spl-token-2022 directly; not modified.
    pub mint: UncheckedAccount<'info>,

    /// Snapshot counter PDA for this mint. May not exist yet.
    /// Seeds: `["snapshot_counter", mint]`, owned by this program.
    ///
    /// CHECK: Address verified by seeds/bump; existence and contents checked in the handler.
    #[account(
        seeds = [b"snapshot_counter", mint.key().as_ref()],
        bump,
    )]
    pub snapshot_counter: UncheckedAccount<'info>,

    /// Holder Balance snapshot PDA for this mint at the current snapshot index.
    /// Seeds: `["snapshot_totalsupply", mint, snapshot_count_le_bytes]`.
    /// Must be writable so it can be created when absent.
    ///
    /// CHECK: Key verified in the handler against the snapshot count; created if absent.
    #[account(mut)]
    pub holder_balance_snapshot: UncheckedAccount<'info>,

    /// CHECK: the token account authenticity will be validated 
    pub holder_token_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
