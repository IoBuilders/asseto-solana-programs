use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

pub use common::program_ids::*;

declare_id!("GpyjQqBWux3JYqxKCXFrDbWZmhFWBJWVaVivkBW2DL2w");

#[program]
pub mod access_control {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::initialize(ctx)
    }

    pub fn grant_roles(ctx: Context<GrantRoles>, roles: Vec<u16>) -> Result<()> {
        grant_roles::grant_roles(ctx, roles)
    }

    pub fn revoke_roles(ctx: Context<RevokeRoles>, roles: Vec<u16>) -> Result<()> {
        revoke_roles::revoke_roles(ctx, roles)
    }
}
