use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;
use common::{pda_seeds, pda_utils, require_active, require_functionality, require_role, roles};
use spl_token_2022_interface::extension::permissioned_burn::instruction::burn as permissioned_burn;

use crate::events::ControllerRedemption;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};

pub fn burn<'info>(ctx: Context<'info, BurnTokens<'info>>, amount: u64) -> Result<()> {
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

    // Token-2022 fires no transfer hook on a burn, so nothing else enforces the hold
    // lien here. Burnt tokens never come back, so a burn over the lien would leave a
    // hold permanently unexecutable.
    common::require_hold_covered(
        &ctx.accounts.token_account.to_account_info(),
        &ctx.accounts.token_account_hold_position_pda,
        amount,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let permanent_delegate_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::permanent_delegate_seeds(&mint_key),
        &ctx.bumps.operations_authority,
    );

    let permissioned_burn_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::permissioned_burn_seeds(&mint_key),
        &ctx.bumps.permissioned_burn_authority,
    );

    // ── Burn via permanent delegate ──────────────────────────────────────────
    //
    // The mint carries the PermissionedBurn extension, so the plain Token-2022
    // `Burn` is rejected — this variant is the one with a signer slot for the
    // permissioned-burn authority alongside the delegate.
    invoke_signed(
        &permissioned_burn(
            &token_program_id,
            &ctx.accounts.token_account.key(),
            &mint_key,
            &ctx.accounts.permissioned_burn_authority.key(),
            &ctx.accounts.operations_authority.key(),
            &[],
            amount,
        )
        .map_err(Error::from)?,
        &[
            ctx.accounts.token_account.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.operations_authority.to_account_info(),
            ctx.accounts.permissioned_burn_authority.to_account_info(),
        ],
        &[
            permanent_delegate_signer_seeds.as_slice(),
            permissioned_burn_signer_seeds.as_slice(),
        ],
    )?;

    // ── 4. Emit ControllerRedemption ─────────────────────────────────────────
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
        seeds = [pda_seeds::PERMISSIONED_BURN, mint.key().as_ref()],
        bump,
    )]
    pub permissioned_burn_authority: UncheckedAccount<'info>,

    /// CHECK: seeds verified; lien read by require_hold_covered. May be empty.
    #[account(
        seeds = [pda_seeds::HOLD_POSITION, mint.key().as_ref(), token_account.key().as_ref()],
        seeds::program = constants::HOLD_PROGRAM_ID,
        bump,
    )]
    pub token_account_hold_position_pda: UncheckedAccount<'info>,

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
