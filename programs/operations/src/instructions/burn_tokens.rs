use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use common::{
    pda_seeds, pda_utils, require_active, require_functionality, verify_deployer_account,
};
use freeze::cpi::accounts::{BlockAccount, UnblockAccount};
use snapshot::cpi::accounts::{UpdateHolderBalanceSnapshot, UpdateTotalSupplySnapshot};
use spl_token_2022::instruction::burn as spl_burn;

use crate::events::ControllerRedemption;
use common::program_ids as constants;
use common::state::{AssetClassVersion, MintOwner};

/// Burns `amount` tokens from any `token_account` for the given mint.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
/// The operations authority PDA (permanent delegate) executes the burn, allowing the
/// deployer to reduce the balance of any holder without their consent.
///
/// Before burning, records the pre-burn total supply and holder balance into any active
/// snapshot (CPIs to snapshot, both signed by `permanent_delegate`).
/// Both CPIs are no-ops when no snapshot has been taken yet.
pub fn burn(ctx: Context<BurnTokens>, amount: u64) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ───────────────────────────
    verify_deployer_account(&ctx.accounts.mint_owner_pda, &ctx.accounts.deployer.key())?;

    // ── Verify mint has not been deactivated ─────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::OPERATIONS_BURN,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let permanent_delegate_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::permanent_delegate_seeds(&mint_key),
        &ctx.bumps.operations_authority,
    );

    // ── 1. Update total supply snapshot (CPI to snapshot) ──────────────
    snapshot::cpi::update_totalsupply_snapshot(CpiContext::new_with_signer(
        constants::SNAPSHOT_PROGRAM_ID,
        UpdateTotalSupplySnapshot {
            calling_authority: ctx.accounts.operations_authority.to_account_info(),
            payer: ctx.accounts.deployer.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            snapshot_counter: ctx.accounts.snapshot_counter_pda.to_account_info(),
            total_supply_snapshot: ctx.accounts.total_supply_snapshot.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
        &[permanent_delegate_signer_seeds.as_slice()],
    ))?;

    // ── 2. Update holder balance snapshot (CPI to snapshot) ────────────
    snapshot::cpi::update_holderbalance_snapshot(
        CpiContext::new_with_signer(
            constants::SNAPSHOT_PROGRAM_ID,
            UpdateHolderBalanceSnapshot {
                calling_authority: ctx.accounts.operations_authority.to_account_info(),
                payer: ctx.accounts.deployer.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                snapshot_counter: ctx.accounts.snapshot_counter_pda.to_account_info(),
                holder_balance_snapshot: ctx.accounts.holder_balance_snapshot.to_account_info(),
                holder_token_account: ctx.accounts.token_account.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[permanent_delegate_signer_seeds.as_slice()],
        ),
        0,
        true,
    )?;

    // ── 3. Unblock token_account (CPI to freeze) ───────────────────────
    freeze::cpi::unblock_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        UnblockAccount {
            calling_authority: ctx.accounts.operations_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.token_account.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[permanent_delegate_signer_seeds.as_slice()],
    ))?;

    // ── 4. Burn via permanent delegate ──────────────────────────────────────────
    invoke_signed(
        &spl_burn(
            &token_program_id,
            &ctx.accounts.token_account.key(),
            &mint_key,
            &ctx.accounts.operations_authority.key(),
            &[],
            amount,
        )
        .map_err(Error::from)?,
        &[
            ctx.accounts.token_account.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.operations_authority.to_account_info(),
        ],
        &[permanent_delegate_signer_seeds.as_slice()],
    )?;

    // ── 5. Re-block token_account (CPI to freeze) ──────────────────────
    freeze::cpi::block_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        BlockAccount {
            calling_authority: ctx.accounts.operations_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.token_account.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[permanent_delegate_signer_seeds.as_slice()],
    ))?;

    // ── 6. Emit ControllerRedemption ─────────────────────────────────────────
    // Emitted last so it only fires when the full burn succeeds.
    emit_cpi!(ControllerRedemption {
        mint: mint_key,
        controller: ctx.accounts.deployer.key(),
        from: ctx.accounts.token_account.key(),
        value: amount,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct BurnTokens<'info> {
    /// The deployer recorded as mint owner — must sign to authorise burning;
    /// marked mutable to pay for snapshot PDA creation.
    #[account(mut)]
    pub deployer: Signer<'info>,

    /// PDA created by deploy that records the deployer for this mint.
    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = mint_owner_pda.bump,
    )]
    pub mint_owner_pda: Account<'info, MintOwner>,

    /// Deactivation marker PDA — must not exist for the instruction to proceed.
    /// Seeds: `["deactivate", mint]`, owned by `deactivate`.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// The Token-2022 mint to burn tokens from.
    ///
    /// CHECK: Writable; validated by Token-2022 during the burn CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    /// The token account to burn from (any holder's account).
    ///
    /// CHECK: Writable; validated by Token-2022 during the burn CPI.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,

    /// Operations authority PDA — acts as the permanent delegate for this mint.
    /// Seeds: `["permanent_delegate", mint]`.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::PERMANENT_DELEGATE, mint.key().as_ref()],
        bump,
    )]
    pub operations_authority: UncheckedAccount<'info>,

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

    /// Snapshot counter PDA for this mint — read by snapshot to determine
    /// the active snapshot index. May not exist yet (no snapshot taken).
    /// Seeds: `["snapshot_counter", mint]`, owned by `snapshot`.
    ///
    /// CHECK: Address verified by seeds/bump; existence and contents checked by snapshot.
    #[account(
        seeds = [pda_seeds::SNAPSHOT_COUNTER, mint.key().as_ref()],
        seeds::program = constants::SNAPSHOT_PROGRAM_ID,
        bump,
    )]
    pub snapshot_counter_pda: UncheckedAccount<'info>,

    /// Total supply snapshot PDA for the current snapshot index.
    /// Dynamic address (depends on snapshot count) — verified inside snapshot.
    /// Created by snapshot if a snapshot is active and not yet recorded.
    ///
    /// CHECK: Writable; address and existence verified inside update_totalsupply_snapshot.
    #[account(mut)]
    pub total_supply_snapshot: UncheckedAccount<'info>,

    /// Holder balance snapshot PDA for the current snapshot index.
    /// Dynamic address (depends on snapshot count) — verified inside snapshot.
    /// Created by snapshot if a snapshot is active and not yet recorded.
    ///
    /// CHECK: Writable; address and existence verified inside update_holderbalance_snapshot.
    #[account(mut)]
    pub holder_balance_snapshot: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::FREEZE_PROGRAM_ID)]
    pub freeze_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::SNAPSHOT_PROGRAM_ID)]
    pub snapshot_program: UncheckedAccount<'info>,

    /// Asset-class version PDA this mint is hooked to.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &mint_owner_pda.asset_class_config_id.to_le_bytes(), &mint_owner_pda.asset_class_version_id.to_le_bytes()],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
