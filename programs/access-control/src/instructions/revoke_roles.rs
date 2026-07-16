use crate::state::Roles;
use anchor_lang::prelude::*;
use common::program_ids as constants;
use common::state::{AssetClassVersion, MintOwner, Roles as RolesCommon};
use common::{
    bitmask, pda_seeds, require_active, require_functionality, require_not_paused, require_role,
    roles,
};

use crate::errors::AccessControlError;

/// Turns off the given role bits for an `(mint, account)` pair.
///
/// The `roles_pda` must already exist (created by a prior `grant_roles`). For
/// each entry in `roles`, clears the corresponding bit to `0` via
/// `mask[byte] &= !(1 << bit)` — a targeted merge, not an overwrite, so bits
/// outside the given list are left untouched.
///
/// Must be signed by an `authority` holding `ROLE_ADMIN` on this mint. Runs only
/// while the mint is neither paused nor deactivated. `account` (the target) is
/// unconstrained — any account is accepted, including the authority itself.
pub fn revoke_roles(ctx: Context<RevokeRoles>, roles: Vec<u16>) -> Result<()> {
    require_role(ctx.accounts.authority_roles_pda.load()?, roles::ROLE_ADMIN)?;
    require_not_paused(&ctx.accounts.mint.to_account_info())?;
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;
    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::ACCESS_CONTROL_REVOKE_ROLES,
    )?;

    let mut roles_account = ctx.accounts.roles_pda.load_mut()?;

    bitmask::clear_bits(&mut roles_account.mask, &roles)
        .map_err(|_| error!(AccessControlError::RoleOutOfBounds))?;

    Ok(())
}

#[derive(Accounts)]
pub struct RevokeRoles<'info> {
    /// The caller — must sign and hold `ROLE_ADMIN` on this mint.
    pub authority: Signer<'info>,

    /// PDA created by deploy that records the deployer for this mint.
    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = mint_owner_pda.bump,
    )]
    pub mint_owner_pda: Account<'info, MintOwner>,

    /// The caller's own `Roles` PDA — read to verify `ROLE_ADMIN`. Seeds: `[mint, authority]`.
    ///
    /// CHECK: Address verified by seeds/bump; admin bit checked by require_admin
    /// (which treats a missing/empty account as "not admin").
    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,

    /// The account the roles are revoked from — unconstrained, any account is accepted.
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

    /// Role bit-mask PDA for `(mint, account)` — must already exist.
    /// Seeds: `[mint, account]`.
    #[account(
        mut,
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), account.key().as_ref()],
        bump = roles_pda.load()?.bump,
    )]
    pub roles_pda: AccountLoader<'info, Roles>,

    /// Asset-class version PDA this mint is hooked to.
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &mint_owner_pda.asset_class_config_id.to_le_bytes(), &mint_owner_pda.asset_class_version_id.to_le_bytes()],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,
}
