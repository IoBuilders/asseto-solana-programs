use anchor_lang::prelude::*;
use common::state::{discriminators_eq, Roles as RolesCommon, ROLES_BYTES_MASK};

#[account(zero_copy, discriminator = RolesCommon::DISCRIMINATOR)]
#[repr(C)]
pub struct Roles {
    pub bump: u8,
    // `mask`'s alignment is 1 (a u8 array), so repr(C) wouldn't insert any
    // padding here on its own — this rounds the header to a deliberate 8 bytes.
    pub _padding: [u8; 7],
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
