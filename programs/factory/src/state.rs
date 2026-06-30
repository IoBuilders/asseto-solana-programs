use anchor_lang::prelude::*;

/// Singleton configuration PDA for the factory, stored at `["factory"]`.
///
/// Created once by `initialize`; the `init` constraint guarantees a second
/// call fails because the account already exists.
#[account]
#[derive(Debug, InitSpace)]
pub struct Factory {
    /// Account authorised to manage the factory.
    pub manager: Pubkey,
    /// Whether the factory is paused. Defaults to `false` at initialization.
    pub pause: bool,
    /// Bump for the `["factory"]` PDA.
    pub bump: u8,
}

/// Singleton pending-manager PDA, stored at `["factory_pending_manager"]`.
///
/// Created/updated by `nominate_manager` when the current manager nominates a
/// successor, and removed by either `accept_nomination` (after the handover) or
/// `cancel_nomination`. Its existence means a manager handover is in progress.
#[account]
#[derive(Debug, InitSpace)]
pub struct FactoryPendingManager {
    /// Account nominated to become the new factory manager.
    pub pending_manager: Pubkey,
    /// Bump for the `["factory_pending_manager"]` PDA.
    pub bump: u8,
}

/// Ownership record for a deployed asset class, stored at
/// `["asset_class_ownership", owner]`.
///
/// Created by `create_asset_class` when the manager creates a new asset class for
/// an `owner`. `latest_version` starts at 0 and tracks the most recent version
/// of the asset class.
#[account]
#[derive(Debug, InitSpace)]
pub struct AssetClassOwnership {
    /// Account that owns this asset class.
    pub owner: Pubkey,
    /// Most recent version of the asset class. Initialised to 0.
    pub latest_version: u64,
    /// Bump for the `["asset_class_ownership", owner]` PDA.
    pub bump: u8,
}
