use anchor_lang::prelude::*;
use common::state::{discriminators_eq, Roles as RolesCommon, ROLES_BYTES_MASK};

#[account(zero_copy, discriminator = RolesCommon::DISCRIMINATOR)]
#[repr(C)]
pub struct Roles {
    /// Bump for the `[mint, account]` PDA.
    pub bump: u8,
    /// Padding so the header is 8 bytes (no implicit padding before `mask`).
    pub _padding: [u8; 7],
    /// Fixed-capacity role bit-mask. `1` = role granted.
    pub mask: [u8; ROLES_BYTES_MASK],
}

const _: () = assert!(
    size_of::<Roles>() == size_of::<RolesCommon>(),
    "access-control::Roles and common::state::Roles have diverged — update both together",
);

const _: () = assert!(
    discriminators_eq(
        <Roles as Discriminator>::DISCRIMINATOR,
        <RolesCommon as Discriminator>::DISCRIMINATOR
    ),
    "access-control::Roles and common::Roles discriminators have diverged — update both together",
);
