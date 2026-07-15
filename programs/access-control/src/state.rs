use anchor_lang::prelude::*;
use common::bitmask::MASK_CHUNK_BITS;

/// Capacity, in bits, of a `Roles` account's role bit-mask.
pub const ROLES_BITS_MASK: usize = 8_192;
/// Capacity of the mask in bytes.
pub const ROLES_BYTES_MASK: usize = ROLES_BITS_MASK / MASK_CHUNK_BITS;

/// Role bit-mask for a single `(mint, account)` pair, stored at `[mint, account]`.
///
/// **Zero-copy** (`AccountLoader`): the mask is large, so the account bytes are
/// reinterpreted in place rather than deserialised as a whole — setting or
/// clearing a single bit (`mask[i / 8] & 1 << (i % 8)`) is cheap.
///
/// Bit `i = 1` means role `i` is granted to `account` on `mint`. `grant_roles`
/// turns bits on, `revoke_roles` turns them off; positions never set stay `0`.
///
/// `#[repr(C)]` with an explicit `_padding` keeps the header at 8 bytes so there
/// is no implicit padding before `mask` (`ROLES_BYTES_MASK` is a multiple of 8).
#[account(zero_copy)]
#[repr(C)]
pub struct Roles {
    /// Bump for the `[mint, account]` PDA.
    pub bump: u8,
    /// Padding so the header is 8 bytes (no implicit padding before `mask`).
    pub _padding: [u8; 7],
    /// Fixed-capacity role bit-mask. `1` = role granted.
    pub mask: [u8; ROLES_BYTES_MASK],
}

// `common::require_role` reads the mask straight from account bytes at
// `common::roles::ROLES_MASK_OFFSET` (8-byte discriminator + this struct's
// header). Guard against the layout drifting from that constant.
const _: () = assert!(
    8 + core::mem::offset_of!(Roles, mask) == common::roles::ROLES_MASK_OFFSET,
    "Roles.mask offset diverged from common::roles::ROLES_MASK_OFFSET"
);
