/// Sourced directly from the cmtat-mint crate — single source of truth.
/// To update: change declare_id! in cmtat-mint/src/lib.rs and Anchor.toml.
pub use cmtat_mint::ID as MINT_AUTHORITY_PROGRAM_ID;

/// Sourced directly from the cmtat-operations crate — single source of truth.
/// To update: change declare_id! in cmtat-operations/src/lib.rs and Anchor.toml.
pub use cmtat_operations::ID as PERMANENT_DELEGATE_PROGRAM_ID;


/// Sourced directly from the cmtat-metadata-update crate — single source of truth.
/// To update: change declare_id! in cmtat-metadata-update/src/lib.rs and Anchor.toml.
pub use cmtat_metadata_update::ID as METADATA_UPDATE_AUTHORITY_PROGRAM_ID;

/// Sourced directly from the cmtat-pause crate — single source of truth.
/// To update: change declare_id! in cmtat-pause/src/lib.rs and Anchor.toml.
pub use cmtat_pause::ID as PAUSABLE_AUTHORITY_PROGRAM_ID;

/// Sourced directly from the cmtat-freeze crate — single source of truth.
/// To update: change declare_id! in cmtat-freeze/src/lib.rs and Anchor.toml.
pub use cmtat_freeze::ID as FREEZE_AUTHORITY_PROGRAM_ID;

/// Sourced directly from the cmtat-transfer-hook crate — single source of truth.
/// To update: change declare_id! in cmtat-transfer-hook/src/lib.rs and Anchor.toml.
pub use cmtat_transfer_hook::ID as TRANSFER_HOOK_PROGRAM_ID;

