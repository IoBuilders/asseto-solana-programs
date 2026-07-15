/// Flat `u16` identifiers for every access-control role in the workspace. One
/// continuous counter across the whole file — values are not scoped per program
/// — so do not reorder or remove an existing constant; only append new ones at
/// the end.
///
/// Named `ROLE_<NAME>`. These map to bit positions in `access-control`'s
/// `Roles.mask` (via `common::bitmask`).
pub const ROLE_ADMIN: u16 = 0;

/// Byte offset of the role bit-mask within an access-control `Roles` account:
/// 8-byte Anchor discriminator + 8-byte header (`bump` + `_padding`). Lets
/// `require_role` read the mask straight from `AccountInfo` without depending on
/// the `access-control` crate. Mirrors `access_control::state::Roles`; a
/// compile-time assertion in that crate guards against drift.
pub const ROLES_MASK_OFFSET: usize = 8 + 8;

#[cfg(test)]
mod tests {
    /// Same guarantee as the `functionalities` test: parses this file's own
    /// source and asserts every `pub const ...: u16 = N;` value equals its
    /// 0-based declaration position. Shared logic lives in `test_support`.
    #[test]
    fn role_constants_are_sequential_from_zero() {
        crate::test_support::assert_u16_constants_sequential_from_zero(
            include_str!("roles.rs"),
            "role",
        );
    }
}
