use anchor_lang::prelude::*;

/// The active transfer control policy for a mint.
///
/// Serialized as a single `u8` (Borsh enum variant index):
/// - `0` → `Clearing`
/// - `1` → `Whitelist`
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum TransferMode {
    Clearing,
    Whitelist,
}

/// Transfer Control Mode PDA.
/// Seeds: `["transfer_control_mode", mint]`
///
/// Created or updated by `set_mode(Some(_))`.
/// Closed (and rent returned) by `set_mode(None)`.
/// When the PDA is absent, no transfer controls are active.
#[account]
pub struct TransferControlMode {
    pub mode: TransferMode,
    pub bump: u8,
}

impl TransferControlMode {
    pub const LEN: usize = 8 + 1 + 1; // discriminator + mode (enum as u8) + bump
}

/// Whitelist marker PDA.
/// Seeds: `["whitelist", mint, account]`
///
/// Created by `add_to_whitelist` and closed by `remove_from_whitelist`.
/// Its existence signals that the token account has been whitelisted for this mint.
#[account]
pub struct WhitelistStatus {
    pub bump: u8,
}

impl WhitelistStatus {
    pub const LEN: usize = 8 + 1; // discriminator + bump
}
