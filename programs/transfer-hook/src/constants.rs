/// Anchor instruction discriminator for `transfer::verify_transfer`.
/// First 8 bytes of `sha256("global:verify_transfer")`.
pub const VERIFY_TRANSFER_DISCRIMINATOR: [u8; 8] = [0x0c, 0x17, 0x4c, 0xe1, 0x96, 0xbf, 0x42, 0x87];

/// Anchor instruction discriminator for `transfer::transfer`.
/// First 8 bytes of `sha256("global:transfer")`.
pub const TRANSFER_DISCRIMINATOR: [u8; 8] = [0xa3, 0x34, 0xc8, 0xe7, 0x8c, 0x03, 0x45, 0xba];

/// Anchor instruction discriminator for `transfer::batch_verify_transfer`.
/// First 8 bytes of `sha256("global:batch_verify_transfer")`.
pub const BATCH_VERIFY_TRANSFER_DISCRIMINATOR: [u8; 8] =
    [0x6d, 0x23, 0xfd, 0xb5, 0xad, 0xf4, 0xbc, 0x52];

/// Anchor instruction discriminator for `transfer::batch_transfer`.
/// First 8 bytes of `sha256("global:batch_transfer")`.
pub const BATCH_TRANSFER_DISCRIMINATOR: [u8; 8] = [0xd1, 0x5a, 0x04, 0x6c, 0x3d, 0xb9, 0x12, 0x8b];

/// Anchor instruction discriminator for `operations::controller_transfer`.
/// First 8 bytes of `sha256("global:controller_transfer")`.
pub const CONTROLLER_TRANSFER_DISCRIMINATOR: [u8; 8] =
    [0xeb, 0x4e, 0x86, 0x08, 0x24, 0xf7, 0x3d, 0x9c];

/// Token-2022 instruction tag for `TransferChecked`. Single byte (it's a Borsh
/// enum variant index, not an Anchor 8-byte discriminator).
pub const TOKEN_2022_TRANSFER_CHECKED_TAG: u8 = 12;
