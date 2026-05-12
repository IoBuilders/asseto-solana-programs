use anchor_lang::prelude::Pubkey;

/// deploy program ID.
/// Hardcoded — deploy depends on transfer-hook (for TRANSFER_HOOK_PROGRAM_ID),
/// which would create a circular dependency if we imported it here.
/// Must be kept in sync with deploy's declare_id! manually.
pub const DEPLOY_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x16, 0xa1, 0xfc, 0x53, 0xc5, 0xea, 0x47, 0x05, 0xd0, 0x7a, 0xc8, 0x28, 0xe3, 0x7c, 0x4b, 0xb2,
    0x74, 0x78, 0x21, 0x82, 0xc5, 0x66, 0x70, 0xfe, 0xf4, 0x76, 0x79, 0xd5, 0x0f, 0x7f, 0x30, 0xe4,
]);

/// Sourced directly from the snapshot crate — single source of truth.
pub use snapshot::ID as SNAPSHOT_PROGRAM_ID;

/// Sourced directly from the freeze crate — single source of truth.
pub use freeze::ID as FREEZE_PROGRAM_ID;

/// Sourced directly from the transfer-control crate — single source of truth.
pub use transfer_control::ID as TRANSFER_CONTROL_PROGRAM_ID;

/// deactivate program ID.
/// Hardcoded — kept in sync manually with deactivate's declare_id!.
pub const DEACTIVATE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x74, 0xb8, 0xf2, 0xcf, 0xb6, 0x45, 0x6c, 0x59, 0x10, 0xb6, 0x46, 0x0f, 0x01, 0x2f, 0xfa, 0x5c,
    0x43, 0x7b, 0xef, 0x01, 0x5a, 0x80, 0x58, 0xeb, 0xa4, 0xad, 0x50, 0x84, 0xff, 0x1f, 0x7e, 0x55,
]);

/// transfer program ID.
/// Hardcoded — transfer depends on transfer-hook for the hook's
/// program ID, so we cannot import transfer back without a circular dep.
/// Must be kept in sync with `transfer/src/lib.rs::declare_id!` manually.
pub const TRANSFER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xc9, 0x1c, 0x16, 0x0a, 0x44, 0x6e, 0x6f, 0xeb, 0x8c, 0xfe, 0xf0, 0x2d, 0x32, 0x3d, 0xc2, 0x32,
    0x4a, 0x0e, 0xcb, 0xef, 0xc7, 0xa8, 0x5b, 0xaa, 0x03, 0x1f, 0x4c, 0xb8, 0xa4, 0xed, 0x87, 0xac,
]);

/// Anchor instruction discriminator for `transfer::verify_transfer`.
/// First 8 bytes of `sha256("global:verify_transfer")`.
pub const VERIFY_TRANSFER_DISCRIMINATOR: [u8; 8] =
    [0x0c, 0x17, 0x4c, 0xe1, 0x96, 0xbf, 0x42, 0x87];

/// Anchor instruction discriminator for `transfer::transfer`.
/// First 8 bytes of `sha256("global:transfer")`.
pub const TRANSFER_DISCRIMINATOR: [u8; 8] =
    [0xa3, 0x34, 0xc8, 0xe7, 0x8c, 0x03, 0x45, 0xba];

/// Token-2022 instruction tag for `TransferChecked`. Single byte (it's a Borsh
/// enum variant index, not an Anchor 8-byte discriminator).
pub const TOKEN_2022_TRANSFER_CHECKED_TAG: u8 = 12;
