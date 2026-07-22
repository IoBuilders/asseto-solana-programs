/// Flat `u16` identifiers for every public instruction in the workspace, excluding `factory`
/// Values are not scoped per program — so do not reorder or remove an existing constant;
/// only append new ones at the end.
///
/// Named `<PROGRAM>_<INSTRUCTION>`.
pub const BOND_UPDATE_BOND_TERMS: u16 = 0;
pub const COUPON_CREATE_COUPON: u16 = 1;
pub const COUPON_SET_COUPON_RATE: u16 = 2;
pub const DEACTIVATE_DEACTIVATE: u16 = 3;
pub const FREEZE_FREEZE_ACCOUNT: u16 = 4;
pub const FREEZE_UNFREEZE_ACCOUNT: u16 = 5;
pub const FREEZE_PARTIALLY_FREEZE_ACCOUNT: u16 = 6;
pub const FREEZE_REMOVE_PARTIAL_FREEZE: u16 = 7;
pub const METADATA_UPDATE_UPDATE_METADATA_FIELD: u16 = 8;
pub const METADATA_UPDATE_REMOVE_METADATA_FIELD: u16 = 9;
pub const MINT_MINT: u16 = 10;
pub const OPERATIONS_BURN: u16 = 11;
pub const PAUSE_PAUSE: u16 = 12;
pub const PAUSE_UNPAUSE: u16 = 13;
pub const TRANSFER_CONTROL_INITIALIZE: u16 = 14;
pub const TRANSFER_CONTROL_ADD_TO_WHITELIST: u16 = 15;
pub const TRANSFER_CONTROL_REMOVE_FROM_WHITELIST: u16 = 16;
pub const TRANSFER_HOOK_EXECUTE: u16 = 17;
pub const TREASURY_SET_PAYMENT_TOKEN: u16 = 18;
pub const TREASURY_PAY_COUPON: u16 = 19;
pub const ACCESS_CONTROL_GRANT_ROLES: u16 = 20;
pub const ACCESS_CONTROL_REVOKE_ROLES: u16 = 21;

#[cfg(test)]
mod tests {
    /// Parses this file's own source (not a separately maintained list, so it
    /// can't drift from reality) and asserts every `pub const ...: u16 = N;`
    /// value equals its 0-based declaration position. Catches gaps,
    /// duplicates, and out-of-order values — the only valid way to add a
    /// functionality is to append a new constant at the end with the next
    /// number. Shared logic lives in `test_support`.
    #[test]
    fn functionality_constants_are_sequential_from_zero() {
        crate::test_support::assert_u16_constants_sequential_from_zero(
            include_str!("functionalities.rs"),
            "functionality",
        );
    }
}
