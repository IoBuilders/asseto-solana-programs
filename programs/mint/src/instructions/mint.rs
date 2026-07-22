use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use common::pda_utils;
use common::state::Roles as RolesCommon;
use common::{pda_seeds, require_active, require_functionality, require_role, roles};
use freeze::cpi::accounts::{BlockAccount, UnblockAccount};
use snapshot::cpi::accounts::{UpdateHolderBalanceSnapshot, UpdateTotalSupplySnapshot};
use spl_token_2022::instruction::mint_to;
use transfer_control::verify_transfer_control_mode;

use crate::events::Issued;
use common::program_ids as constants;
use common::state::{AssetClassVersion, MintOwner};

/// Mints `amount` tokens of the given mint to `destination`.
///
///
/// Before minting, records the pre-mint total supply and destination balance into
/// any active snapshot (CPIs to snapshot, both signed by `mint_authority`).
/// Both CPIs are no-ops when no snapshot has been taken yet.
///
/// Because all token accounts are frozen by default, the instruction thaws
/// `destination` before minting (CPI to freeze) and re-freezes it
/// immediately after (CPI to freeze). Both CPIs are signed by the
/// `mint_authority` PDA, which is the only caller freeze accepts.
pub fn mint(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
    require_role(ctx.accounts.authority_roles_pda.load()?, roles::ROLE_ISSUER)?;

    // ── Verify mint has not been deactivated ─────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::MINT_MINT,
    )?;

    // ── Transfer control mode check ──────────────────────────────────────
    verify_transfer_control_mode(
        &ctx.accounts.transfer_control_mode_pda.to_account_info(),
        &[&ctx.accounts.destination_whitelist_pda.to_account_info()],
    )?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let mint_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::mint_authority_seeds(&mint_key),
        &ctx.bumps.mint_authority,
    );

    // ── 1. Update total supply snapshot (CPI to snapshot) ──────────────
    snapshot::cpi::update_totalsupply_snapshot(CpiContext::new_with_signer(
        constants::SNAPSHOT_PROGRAM_ID,
        UpdateTotalSupplySnapshot {
            calling_authority: ctx.accounts.mint_authority.to_account_info(),
            payer: ctx.accounts.deployer.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            snapshot_counter: ctx.accounts.snapshot_counter_pda.to_account_info(),
            total_supply_snapshot: ctx.accounts.total_supply_snapshot.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
        &[mint_authority_signer_seeds.as_slice()],
    ))?;

    // ── 2. Update holder balance snapshot (CPI to snapshot) ────────────
    snapshot::cpi::update_holderbalance_snapshot(
        CpiContext::new_with_signer(
            constants::SNAPSHOT_PROGRAM_ID,
            UpdateHolderBalanceSnapshot {
                calling_authority: ctx.accounts.mint_authority.to_account_info(),
                payer: ctx.accounts.deployer.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                snapshot_counter: ctx.accounts.snapshot_counter_pda.to_account_info(),
                holder_balance_snapshot: ctx.accounts.holder_balance_snapshot.to_account_info(),
                holder_token_account: ctx.accounts.destination.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[mint_authority_signer_seeds.as_slice()],
        ),
        0,
        true,
    )?;

    // ── 3. Unblock destination (CPI to freeze) ─────────────────────────
    freeze::cpi::unblock_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        UnblockAccount {
            calling_authority: ctx.accounts.mint_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.destination.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[mint_authority_signer_seeds.as_slice()],
    ))?;

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
        &[mint_authority_signer_seeds.as_slice()],
    )?;

    emit_cpi!(Issued {
        mint: mint_key,
        operator: ctx.accounts.authority.key(),
        to: ctx.accounts.destination.key(),
        value: amount,
    });

    // ── 5. Re-block destination (CPI to freeze) ────────────────────────
    freeze::cpi::block_account(CpiContext::new_with_signer(
        constants::FREEZE_PROGRAM_ID,
        BlockAccount {
            calling_authority: ctx.accounts.mint_authority.to_account_info(),
            freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_account: ctx.accounts.destination.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        },
        &[mint_authority_signer_seeds.as_slice()],
    ))?;

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct MintTokens<'info> {
    /// The deployer recorded as mint owner in mint_owner_pda.
    /// Must sign to authorise minting; marked mutable to pay for snapshot PDA creation.
    #[account(mut)]
    pub deployer: Signer<'info>,

    /// The caller — must sign and hold `ROLE_ISSUER` on this mint.
    pub authority: Signer<'info>,

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

    /// The Token-2022 mint to issue tokens from.
    ///
    /// CHECK: Writable; validated by Token-2022 during the mint_to CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    /// Mint authority PDA owned by this program — the only key authorised to
    /// call mint_to on the Token-2022 mint, and the only caller freeze accepts
    /// for freeze/thaw instructions.
    /// Seeds: `["mint_authority", mint]`.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::MINT_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// The token account that will receive the minted tokens.
    /// Thawed before minting and re-frozen after.
    ///
    /// CHECK: Writable; validated by Token-2022 and freeze during CPIs.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

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

    /// Transfer Control Mode PDA for this mint.
    /// Seeds: `["transfer_control_mode", mint]`, owned by `transfer-control`.
    /// Read to determine whether whitelist mode is active for the mint.
    ///
    /// CHECK: Address verified by seeds/bump; contents read by get_transfer_mode.
    #[account(
        seeds = [pda_seeds::TRANSFER_CONTROL_MODE, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub transfer_control_mode_pda: UncheckedAccount<'info>,

    /// Whitelist marker PDA for the destination token account.
    /// Seeds: `["whitelist", mint, destination]`, owned by `transfer-control`.
    /// Must exist when whitelist mode is active; ignored otherwise.
    ///
    /// CHECK: Address verified by seeds/bump; existence checked by verify_whitelist if needed.
    #[account(
        seeds = [pda_seeds::WHITELIST, mint.key().as_ref(), destination.key().as_ref()],
        seeds::program = constants::TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub destination_whitelist_pda: UncheckedAccount<'info>,

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

    /// The caller's own `Roles` PDA — read to verify `ROLE_ISSUER`. Seeds: `["roles", mint, authority]`.
    ///
    /// CHECK: Address verified by seeds/bump; issuer bit checked by require_role.
    /// An absent PDA fails at account resolution (AccountOwnedByWrongProgram).
    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,
}
