use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use common::{pda_seeds, pda_utils, require_active, require_functionality, require_role, roles};
use freeze::cpi::accounts::{BlockAccount, UnblockAccount};
use snapshot::cpi::accounts::UpdateHolderBalanceSnapshot;
use spl_token_2022::instruction::burn as spl_burn;

use crate::events::ControllerRedemption;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};

pub fn burn(ctx: Context<BurnTokens>, amount: u64) -> Result<()> {
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_CONTROLLER,
    )?;

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

    // ── 1. Update holder balance snapshot (CPI to snapshot) ────────────
    snapshot::cpi::update_holderbalance_snapshot(
        CpiContext::new_with_signer(
            constants::SNAPSHOT_PROGRAM_ID,
            UpdateHolderBalanceSnapshot {
                calling_authority: ctx.accounts.operations_authority.to_account_info(),
                payer: ctx.accounts.payer.to_account_info(),
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

    // ── 2. Unblock token_account (CPI to freeze) ───────────────────────
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

    // ── 3. Burn via permanent delegate ──────────────────────────────────────────
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

    // ── 4. Re-block token_account (CPI to freeze) ──────────────────────
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

    // ── 5. Emit ControllerRedemption ─────────────────────────────────────────
    // Emitted last so it only fires when the full burn succeeds.
    emit_cpi!(ControllerRedemption {
        mint: mint_key,
        controller: ctx.accounts.authority.key(),
        from: ctx.accounts.token_account.key(),
        value: amount,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct BurnTokens<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub authority: Signer<'info>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// CHECK: Writable; validated by Token-2022 during the burn CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Writable; validated by Token-2022 during the burn CPI.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::PERMANENT_DELEGATE, mint.key().as_ref()],
        bump,
    )]
    pub operations_authority: UncheckedAccount<'info>,

    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [pda_seeds::FREEZE_AUTHORITY, mint.key().as_ref()],
        seeds::program = constants::FREEZE_PROGRAM_ID,
        bump,
    )]
    pub freeze_authority: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; existence and contents checked by snapshot.
    #[account(
        seeds = [pda_seeds::SNAPSHOT_COUNTER, mint.key().as_ref()],
        seeds::program = constants::SNAPSHOT_PROGRAM_ID,
        bump,
    )]
    pub snapshot_counter_pda: UncheckedAccount<'info>,

    /// CHECK: Writable; address and existence verified inside update_holderbalance_snapshot.
    #[account(mut)]
    pub holder_balance_snapshot: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::FREEZE_PROGRAM_ID)]
    pub freeze_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::SNAPSHOT_PROGRAM_ID)]
    pub snapshot_program: UncheckedAccount<'info>,

    #[account(
        seeds = [
            pda_seeds::ASSET_CLASS_VERSION,
            &asset_configuration_pda.asset_class_config_id.to_le_bytes(),
            &asset_configuration_pda.asset_class_version_id.to_le_bytes()
        ],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,

    /// CHECK: Address verified by seeds/bump; controller bit checked by require_role.
    /// An absent PDA fails at account resolution (AccountOwnedByWrongProgram).
    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,
}
