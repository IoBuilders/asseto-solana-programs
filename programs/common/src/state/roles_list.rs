use crate::bitmask::MASK_CHUNK_BITS;
use anchor_lang::prelude::*;
use anchor_lang::ZeroCopy;
use bytemuck::{Pod, Zeroable};

/// Capacity, in bits, of a `Roles` account's role bit-mask.
pub const ROLES_BITS_MASK: usize = 8_192;
/// Capacity of the mask in bytes.
pub const ROLES_BYTES_MASK: usize = ROLES_BITS_MASK / MASK_CHUNK_BITS;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct Roles {
    /// Bump for the `[mint, account]` PDA.
    pub bump: u8,
    /// Padding so the header is 8 bytes (no implicit padding before `mask`).
    pub _padding: [u8; 7],
    /// Fixed-capacity role bit-mask. `1` = role granted.
    pub mask: [u8; ROLES_BYTES_MASK],
}

impl Discriminator for Roles {
    /// The 8-byte Anchor account discriminator for `access-control::state::Roles`
    /// (`sha256("account:Roles")[..8]`).
    /// Computed here since this crate has no `declare_id!`/`#[account]` to derive it from
    /// Defined in `common` so all downstream programs can deserialize it
    const DISCRIMINATOR: &'static [u8] = &[177, 37, 17, 201, 242, 158, 212, 65];
}

// Defines the owner program of the `Roles` account
impl Owner for Roles {
    fn owner() -> Pubkey {
        crate::program_ids::ACCESS_CONTROL_PROGRAM_ID
    }
}

// Not `#[account]`-tagged zero-copy structs need to manually implement this
impl ZeroCopy for Roles {}

// Not `#[account]`-tagged zero-copy structs need to manually implement this
#[cfg(feature = "idl-build")]
impl IdlBuild for Roles {}
