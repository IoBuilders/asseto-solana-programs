use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use spl_token_2022::instruction::mint_to;
use cmtat_common::require_active;
use cmtat_common::verify_deployer;
use cmtat_freeze::cpi::accounts::{BlockAccount, UnblockAccount};
use cmtat_snapshot::cpi::accounts::{UpdateHolderBalanceSnapshot, UpdateTotalSupplySnapshot};
use cmtat_transfer_control::{get_transfer_mode, verify_whitelist, TransferMode};

use crate::constants;

/// Mints `amount` tokens of the given mint to `destination`.
///
/// Only the deployer recorded in `mint_owner_pda` may call this instruction.
///
/// Before minting, records the pre-mint total supply and destination balance into
/// any active snapshot (CPIs to cmtat-snapshot, both signed by `mint_authority`).
/// Both CPIs are no-ops when no snapshot has been taken yet.
///
/// Because all token accounts are frozen by default, the instruction thaws
/// `destination` before minting (CPI to cmtat-freeze) and re-freezes it
/// immediately after (CPI to cmtat-freeze). Both CPIs are signed by the
/// `mint_authority` PDA, which is the only caller cmtat-freeze accepts.
pub fn mint(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ───────────────────────────
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;

    // ── Verify mint has not been deactivated ─────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    // ── If whitelist mode is active, verify destination is whitelisted ────────
    if get_transfer_mode(&ctx.accounts.transfer_control_mode_pda.to_account_info())?
        == Some(TransferMode::Whitelist)
    {
        verify_whitelist(&ctx.accounts.destination_whitelist_pda.to_account_info())?;
    }

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let mint_authority_seeds: &[&[u8]] = &[
        b"mint_authority",
        mint_key.as_ref(),
        &[ctx.bumps.mint_authority],
    ];

    // ── 1. Update total supply snapshot (CPI to cmtat-snapshot) ──────────────
    cmtat_snapshot::cpi::update_totalsupply_snapshot(
        CpiContext::new_with_signer(
            ctx.accounts.snapshot_program.to_account_info(),
            UpdateTotalSupplySnapshot {
                calling_authority: ctx.accounts.mint_authority.to_account_info(),
                payer: ctx.accounts.deployer.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                snapshot_counter: ctx.accounts.snapshot_counter_pda.to_account_info(),
                total_supply_snapshot: ctx.accounts.total_supply_snapshot.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[mint_authority_seeds],
        ),
    )?;

    // ── 2. Update holder balance snapshot (CPI to cmtat-snapshot) ────────────
    cmtat_snapshot::cpi::update_holderbalance_snapshot(
        CpiContext::new_with_signer(
            ctx.accounts.snapshot_program.to_account_info(),
            UpdateHolderBalanceSnapshot {
                calling_authority: ctx.accounts.mint_authority.to_account_info(),
                payer: ctx.accounts.deployer.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                snapshot_counter: ctx.accounts.snapshot_counter_pda.to_account_info(),
                holder_balance_snapshot: ctx.accounts.holder_balance_snapshot.to_account_info(),
                holder_token_account: ctx.accounts.destination.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[mint_authority_seeds],
        ),
    )?;

    // ── 3. Unblock destination (CPI to cmtat-freeze) ─────────────────────────
    cmtat_freeze::cpi::unblock_account(
        CpiContext::new_with_signer(
            ctx.accounts.block_program.to_account_info(),
            UnblockAccount {
                calling_authority: ctx.accounts.mint_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: ctx.accounts.destination.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[mint_authority_seeds],
        ),
    )?;

    // ── 4. Mint tokens (CPI to Token-2022) ──────────────────────────────────
    invoke_signed(
        &mint_to(
            &token_program_id,
            &mint_key,
            &ctx.accounts.destination.key(),
            &ctx.accounts.mint_authority.key(),
            &[],
            amount,
        )
        .map_err(Error::from)?,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.mint_authority.to_account_info(),
        ],
        &[mint_authority_seeds],
    )?;

    // ── 5. Re-block destination (CPI to cmtat-freeze) ────────────────────────
    cmtat_freeze::cpi::block_account(
        CpiContext::new_with_signer(
            ctx.accounts.block_program.to_account_info(),
            BlockAccount {
                calling_authority: ctx.accounts.mint_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: ctx.accounts.destination.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[mint_authority_seeds],
        ),
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct MintTokens<'info> {
    /// The deployer recorded as mint owner in mint_owner_pda.
    /// Must sign to authorise minting; marked mutable to pay for snapshot PDA creation.
    #[account(mut)]
    pub deployer: Signer<'info>,

    /// PDA created by cmtat-deploy that records the deployer for this mint.
    /// The seeds constraint guarantees this is the canonical PDA for the mint;
    /// the instruction body checks that `deployer` matches the stored pubkey via
    /// Anchor deserialization (MintOwner::try_deserialize) inside verify_deployer.
    /// UncheckedAccount is used because Account<MintOwner> would enforce ownership
    /// by the current program, but this account is owned by cmtat-deploy.
    ///
    /// CHECK: Address verified by seeds/bump; contents Anchor-deserialized by verify_deployer.
    #[account(
        seeds = [b"mint_owner", mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub mint_owner_pda: UncheckedAccount<'info>,

    /// Deactivation marker PDA — must not exist for the instruction to proceed.
    /// Seeds: `["deactivate", mint]`, owned by `cmtat-deactivate`.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked by verify_deactivate.
    #[account(
        seeds = [b"deactivate", mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// The Token-2022 mint to issue tokens from.
    ///
    /// CHECK: Writable; validated by Token-2022 during the mint_to CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    /// Mint authority PDA owned by this program — the only key authorised to
    /// call mint_to on the Token-2022 mint, and the only caller cmtat-freeze accepts
    /// for freeze/thaw instructions.
    /// Seeds: `["mint_authority", mint]`.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [b"mint_authority", mint.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// The token account that will receive the minted tokens.
    /// Thawed before minting and re-frozen after.
    ///
    /// CHECK: Writable; validated by Token-2022 and cmtat-freeze during CPIs.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    /// cmtat-freeze's freeze authority PDA for this mint.
    /// Passed through to cmtat-freeze for the freeze/thaw CPIs.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [b"freeze_authority", mint.key().as_ref()],
        seeds::program = constants::CMTAT_FREEZE_PROGRAM_ID,
        bump,
    )]
    pub freeze_authority: UncheckedAccount<'info>,

    /// Transfer Control Mode PDA for this mint.
    /// Seeds: `["transfer_control_mode", mint]`, owned by `cmtat-transfer-control`.
    /// Read to determine whether whitelist mode is active for the mint.
    ///
    /// CHECK: Address verified by seeds/bump; contents read by get_transfer_mode.
    #[account(
        seeds = [b"transfer_control_mode", mint.key().as_ref()],
        seeds::program = constants::CMTAT_TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub transfer_control_mode_pda: UncheckedAccount<'info>,

    /// Whitelist marker PDA for the destination token account.
    /// Seeds: `["whitelist", mint, destination]`, owned by `cmtat-transfer-control`.
    /// Must exist when whitelist mode is active; ignored otherwise.
    ///
    /// CHECK: Address verified by seeds/bump; existence checked by verify_whitelist if needed.
    #[account(
        seeds = [b"whitelist", mint.key().as_ref(), destination.key().as_ref()],
        seeds::program = constants::CMTAT_TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub destination_whitelist_pda: UncheckedAccount<'info>,

    /// Snapshot counter PDA for this mint — read by cmtat-snapshot to determine
    /// the active snapshot index. May not exist yet (no snapshot taken).
    /// Seeds: `["snapshot_counter", mint]`, owned by `cmtat-snapshot`.
    ///
    /// CHECK: Address verified by seeds/bump; existence and contents checked by cmtat-snapshot.
    #[account(
        seeds = [b"snapshot_counter", mint.key().as_ref()],
        seeds::program = constants::CMTAT_SNAPSHOT_PROGRAM_ID,
        bump,
    )]
    pub snapshot_counter_pda: UncheckedAccount<'info>,

    /// Total supply snapshot PDA for the current snapshot index.
    /// Dynamic address (depends on snapshot count) — verified inside cmtat-snapshot.
    /// Created by cmtat-snapshot if a snapshot is active and not yet recorded.
    ///
    /// CHECK: Writable; address and existence verified inside update_totalsupply_snapshot.
    #[account(mut)]
    pub total_supply_snapshot: UncheckedAccount<'info>,

    /// Holder balance snapshot PDA for the current snapshot index.
    /// Dynamic address (depends on snapshot count) — verified inside cmtat-snapshot.
    /// Created by cmtat-snapshot if a snapshot is active and not yet recorded.
    ///
    /// CHECK: Writable; address and existence verified inside update_holderbalance_snapshot.
    #[account(mut)]
    pub holder_balance_snapshot: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::CMTAT_FREEZE_PROGRAM_ID)]
    pub block_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::CMTAT_SNAPSHOT_PROGRAM_ID)]
    pub snapshot_program: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
