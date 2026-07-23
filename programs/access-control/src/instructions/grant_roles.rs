use anchor_lang::prelude::*;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};
use common::{
    bitmask, pda_seeds, require_active, require_functionality, require_not_paused, require_role,
    roles,
};

use crate::errors::AccessControlError;
use crate::state::Roles;

/// Turns on the given role bits for an `(mint, account)` pair.
///
/// Creates the `roles_pda` on the first call (`init_if_needed`) or updates it if
/// it already exists. For each entry in `roles`, sets the corresponding bit to
/// `1` via `mask[byte] |= 1 << bit` — a targeted merge, not an overwrite, so
/// bits outside the given list are left untouched.
///
/// Must be signed by an `authority` holding `ROLE_ADMIN` on this mint. Runs only
/// while the mint is neither paused nor deactivated. `account` (the grantee) is
/// unconstrained — any account may be granted roles, including the authority
/// itself.
pub fn grant_roles(ctx: Context<GrantRoles>, roles: Vec<u16>) -> Result<()> {
    require_role(ctx.accounts.authority_roles_pda.load()?, roles::ROLE_ADMIN)?;
    require_not_paused(&ctx.accounts.mint.to_account_info())?;
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;
    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::ACCESS_CONTROL_GRANT_ROLES,
    )?;

    // `load_init` succeeds only on a freshly created PDA (discriminator still
    // zero); for an already-existing one it errors and we load it mutably.
    let mut roles_account = match ctx.accounts.roles_pda.load_init() {
        Ok(mut roles_account) => {
            roles_account.bump = ctx.bumps.roles_pda;
            roles_account
        }
        Err(_) => ctx.accounts.roles_pda.load_mut()?,
    };

    bitmask::set_bits(&mut roles_account.mask, &roles)
        .map_err(|_| error!(AccessControlError::RoleOutOfBounds))?;

    Ok(())
}

#[derive(Accounts)]
pub struct GrantRoles<'info> {
    /// Pays for the `roles_pda` on the first call.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The caller — must sign and hold `ROLE_ADMIN` on this mint.
    pub authority: Signer<'info>,

    /// PDA that contains the configuration for this mint.
    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// The caller's own `Roles` PDA — read to verify `ROLE_ADMIN`. Seeds: `[mint, authority]`.
    ///
    /// CHECK: Address verified by seeds/bump; admin bit checked by require_admin
    /// (which treats a missing/empty account as "not admin").
    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,

    /// The account the roles are granted to — unconstrained, any account is accepted.
    /// CHECK: used only as a seed for `roles_pda`.
    pub account: UncheckedAccount<'info>,

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

    /// The Token-2022 mint — must not be paused.
    ///
    /// CHECK: Read-only; pause state validated by require_not_paused.
    pub mint: UncheckedAccount<'info>,

    /// Role bit-mask PDA for `(mint, account)` — created on the first grant,
    /// updated on subsequent grants. Seeds: `[mint, account]`.
    #[account(
        init_if_needed,
        payer = payer,
        space = Roles::DISCRIMINATOR.len() + std::mem::size_of::<Roles>(),
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), account.key().as_ref()],
        bump,
    )]
    pub roles_pda: AccountLoader<'info, Roles>,

    pub system_program: Program<'info, System>,

    /// Asset-class version PDA this mint is hooked to.
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
}
