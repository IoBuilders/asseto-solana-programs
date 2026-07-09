use anchor_lang::prelude::*;
use common::state::{
    discriminators_eq, AssetClassVersion as AssetClassVersionCommon, FUNCTIONALITIES_BYTES_MASK,
};

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

/// Pending-owner PDA for an asset class, stored at
/// `["asset_class_pending_owner", config_id]`.
///
/// Created/updated by `nominate_asset_class_owner` when the current owner
/// nominates a successor, and removed by either `accept_asset_class_ownership`
/// (after the handover) or `cancel_asset_class_ownership`. Its existence means an
/// asset-class ownership handover is in progress.
#[account]
#[derive(Debug, InitSpace)]
pub struct AssetClassPendingOwner {
    /// Account nominated to become the new asset class owner.
    pub pending_owner: Pubkey,
    /// Bump for the `["asset_class_pending_owner", config_id]` PDA.
    pub bump: u8,
}

/// Lifecycle state of an asset-class version, stored as a `u8` (zero-copy /
/// `Pod` accounts cannot hold a Borsh enum).
pub const STATE_DRAFT: u8 = 0;
/// Mask sealed; the version is immutable and usable by `deploy`/`mint`.
pub const STATE_READY: u8 = 1;

/// One version of an asset class, stored at
/// `["asset_class_version", config_id, version]`.
///
/// **Zero-copy** (`AccountLoader`): the account bytes are reinterpreted in place,
/// never copied/deserialised as a whole, so reading a single functionality bit
/// (`mask[i / 8] >> (i % 8) & 1`) is cheap even though the mask is large. The
/// layout is `#[repr(C)]` with no implicit padding (the explicit `_padding`
/// keeps the header at 24 bytes; `FUNCTIONALITIES_BYTES_MASK` is a multiple of 8).
///
/// A version is fully defined by its bit-mask: bit `i = 1` means "functionality
/// `i` is activated". The mask is fixed-capacity, so there is no length to track.
/// Each version starts from a fresh, all-zero mask at `init` — nothing is
/// inherited from the previous version. While the version is `Draft`,
/// `enable_asset_class_version_functionalities` / `disable_asset_class_version_functionalities`
/// may freely turn bits on or off; once sealed (`Ready`), the mask is immutable.
///
/// MIRROR: `common::state::AssetClassVersion` holds the same fields, field for
/// field, so `common::functionalities::require_functionality` can locate the
/// mask without depending on `factory`. Both must stay in sync — the
/// compile-time assertion below guards against divergence.
#[account(zero_copy, discriminator = AssetClassVersionCommon::DISCRIMINATOR)]
#[repr(C)]
pub struct AssetClassVersion {
    /// Asset class config this version belongs to.
    pub config_id: u64,
    /// Version number (1-based); equals `AssetClassOwnership.latest_version + 1`
    /// at the time `init` ran.
    pub version: u64,
    /// `STATE_DRAFT` while the mask is being written, `STATE_READY` once sealed.
    pub state: u8,
    /// Bump for the `["asset_class_version", config_id, version]` PDA.
    pub bump: u8,
    /// Padding so the header is 24 bytes (no implicit padding before `mask`).
    pub _padding: [u8; 6],
    /// Fixed-capacity functionality bit-mask. `1` = functionality activated.
    /// Positions never set stay `0` (disabled).
    pub mask: [u8; FUNCTIONALITIES_BYTES_MASK],
}

const _: () = assert!(
    size_of::<AssetClassVersion>() == size_of::<AssetClassVersionCommon>(),
    "factory::AssetClassVersion and common::state::AssetClassVersion have diverged — update both together",
);

const _: () = assert!(
    discriminators_eq(
        <AssetClassVersion as Discriminator>::DISCRIMINATOR,
        <AssetClassVersionCommon as Discriminator>::DISCRIMINATOR
    ),
    "factory::AssetClassVersion and common::AssetClassVersion discriminators have diverged — update both together",
);
