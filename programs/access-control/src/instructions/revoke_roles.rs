use crate::state::Roles;
use anchor_lang::prelude::*;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};
use common::{
    bitmask, pda_seeds, require_active, require_functionality, require_not_paused, require_role,
    roles,
};

use crate::errors::AccessControlError;

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
    pub authority: Signer<'info>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: Address verified by seeds/bump; admin bit checked by require_admin
    /// (which treats a missing/empty account as "not admin").
    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,

    /// CHECK: used only as a seed for `roles_pda`.
    pub account: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// CHECK: Read-only; pause state validated by require_not_paused.
    pub mint: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), account.key().as_ref()],
        bump = roles_pda.load()?.bump,
    )]
    pub roles_pda: AccountLoader<'info, Roles>,

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
