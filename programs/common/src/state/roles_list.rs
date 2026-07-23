use crate::bitmask::MASK_CHUNK_BITS;
use anchor_lang::prelude::*;
use anchor_lang::ZeroCopy;
use bytemuck::{Pod, Zeroable};

pub const ROLES_BITS_MASK: usize = 8_192;
pub const ROLES_BYTES_MASK: usize = ROLES_BITS_MASK / MASK_CHUNK_BITS;

/// Full field-for-field mirror of `access-control::state::Roles`,
/// which must stay in sync with this struct, field for field.
/// A compile-time size assertion in `access-control/src/state.rs` guards against divergence.
///
/// Defined in `common` so all downstream programs can deserialize it without
/// importing `access-control` (which would create circular dependencies).
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct Roles {
    pub bump: u8,
    // `bump` (1 byte) + this padding (7 bytes) round the header to 8 bytes,
    // so `mask` starts at a fixed byte offset of 8.
    pub _padding: [u8; 7],
    pub mask: [u8; ROLES_BYTES_MASK],
}

impl Discriminator for Roles {
    /// The 8-byte Anchor account discriminator for `access-control::state::Roles`
    /// (`sha256("account:Roles")[..8]`).
    /// Computed here since this crate has no `declare_id!`/`#[account]` to derive it from
    /// Defined in `common` so all downstream programs can deserialize it
    const DISCRIMINATOR: &'static [u8] = &[177, 37, 17, 201, 242, 158, 212, 65];
}

impl Owner for Roles {
    fn owner() -> Pubkey {
        crate::program_ids::ACCESS_CONTROL_PROGRAM_ID
    }
}

// Not `#[account]`-tagged zero-copy structs need to manually implement these.
impl ZeroCopy for Roles {}

#[cfg(feature = "idl-build")]
impl IdlBuild for Roles {}
