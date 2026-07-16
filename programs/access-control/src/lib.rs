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

    /// Initializes the access control system for the given mint and account.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::initialize(ctx)
    }

    /// Grants (turns on) the given role bits for the provided account on the mint.
    /// Creates the roles PDA on the first call, updates it afterwards. Runs only
    /// while the mint is neither paused nor deactivated.
    pub fn grant_roles(ctx: Context<GrantRoles>, roles: Vec<u16>) -> Result<()> {
        grant_roles::grant_roles(ctx, roles)
    }

    /// Revokes (turns off) the given role bits for the provided account on the mint.
    /// The roles PDA must already exist. Runs only while the mint is neither
    /// paused nor deactivated.
    pub fn revoke_roles(ctx: Context<RevokeRoles>, roles: Vec<u16>) -> Result<()> {
        revoke_roles::revoke_roles(ctx, roles)
    }
}
