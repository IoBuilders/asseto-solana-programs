use anchor_lang::prelude::*;

use crate::state::{FUNCTIONALITIES_BITS_MASK, FUNCTIONALITIES_MASK_CHUNK_BITS};
use crate::CommonError;

/// Flat `u16` identifiers for every instruction in the workspace, excluding
/// `factory` (which consumes these constants, but doesn't define any of its
/// own). One continuous counter across the whole file — values are not
/// scoped per program — so do not reorder or remove an existing constant;
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
pub const SNAPSHOT_TAKE_SNAPSHOT: u16 = 14;
pub const SNAPSHOT_UPDATE_TOTALSUPPLY_SNAPSHOT: u16 = 15;
pub const SNAPSHOT_UPDATE_HOLDERBALANCE_SNAPSHOT: u16 = 16;
pub const TRANSFER_TRANSFER: u16 = 17;
pub const TRANSFER_VERIFY_TRANSFER: u16 = 18;
pub const TRANSFER_CONTROL_SET_MODES: u16 = 19;
pub const TRANSFER_CONTROL_ADD_TO_WHITELIST: u16 = 20;
pub const TRANSFER_CONTROL_REMOVE_FROM_WHITELIST: u16 = 21;
pub const TRANSFER_HOOK_INITIALIZE_EXTRA_ACCOUNT_META_LIST: u16 = 22;
pub const TRANSFER_HOOK_EXECUTE: u16 = 23;
pub const TREASURY_SET_PAYMENT_TOKEN: u16 = 24;
pub const TREASURY_PAY_COUPON: u16 = 25;

/// Returns `(byte, bit)`: the index of the byte in `AssetClassVersion.mask`
/// and the bit position within that byte for the given functionality.
pub fn index_of(functionality: u16) -> Result<(usize, usize)> {
    let i = functionality as usize;
    require!(
        i < FUNCTIONALITIES_BITS_MASK,
        CommonError::FunctionalityOutOfBounds
    );
    let byte = i / FUNCTIONALITIES_MASK_CHUNK_BITS;
    let bit = i % FUNCTIONALITIES_MASK_CHUNK_BITS;
    Ok((byte, bit))
}

#[cfg(test)]
mod tests {
    /// Parses this file's own source (not a separately maintained list, so it
    /// can't drift from reality) and asserts every `pub const ...: u16 = N;`
    /// value equals its 0-based declaration position. Catches gaps,
    /// duplicates, and out-of-order values — the only valid way to add a
    /// functionality is to append a new constant at the end with the next
    /// number.
    #[test]
    fn functionality_constants_are_sequential_from_zero() {
        let source = include_str!("functionalities.rs");
        let mut values: Vec<u16> = Vec::new();

        for line in source.lines() {
            let line = line.trim();
            let Some(rest) = line.strip_prefix("pub const ") else {
                continue;
            };
            let Some((name_and_type, value_part)) = rest.split_once('=') else {
                continue;
            };
            if !name_and_type.contains(": u16") {
                continue;
            }
            let value_str = value_part.trim().trim_end_matches(';');
            let value: u16 = value_str
                .parse()
                .unwrap_or_else(|_| panic!("expected an integer literal, found `{value_str}`"));
            values.push(value);
        }

        assert!(
            !values.is_empty(),
            "expected at least one functionality constant"
        );
        for (i, &value) in values.iter().enumerate() {
            assert_eq!(
                value, i as u16,
                "functionality constants must be sequential starting at 0, in declaration order"
            );
        }
    }
}
