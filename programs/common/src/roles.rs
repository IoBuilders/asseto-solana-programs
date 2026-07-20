/// Flat `u16` identifiers for every access-control role in the workspace. One
/// continuous counter across the whole file — values are not scoped per program
/// — so do not reorder or remove an existing constant; only append new ones at
/// the end.
///
/// Named `ROLE_<NAME>`. These map to bit positions in `access-control`'s
/// `Roles.mask` (via `common::bitmask`).
pub const ROLE_ADMIN: u16 = 0;
pub const ROLE_CONTROLLER: u16 = 1;
pub const ROLE_CONTROL_LIST: u16 = 2;
pub const ROLE_CORPORATE_ACTION: u16 = 3;
pub const ROLE_ISSUER: u16 = 4;
pub const ROLE_TREASURER: u16 = 5;
pub const ROLE_PAUSER: u16 = 6;
pub const ROLE_FREEZE_MANAGER: u16 = 7;
pub const ROLE_DEACTIVATE: u16 = 8;

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
