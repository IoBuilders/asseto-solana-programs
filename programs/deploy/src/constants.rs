/// Sourced directly from the mint crate — single source of truth.
/// To update: change declare_id! in mint/src/lib.rs and Anchor.toml.
pub use mint::ID as MINT_AUTHORITY_PROGRAM_ID;

/// Sourced directly from the operations crate — single source of truth.
/// To update: change declare_id! in operations/src/lib.rs and Anchor.toml.
pub use operations::ID as PERMANENT_DELEGATE_PROGRAM_ID;


/// Sourced directly from the metadata-update crate — single source of truth.
/// To update: change declare_id! in metadata-update/src/lib.rs and Anchor.toml.
pub use metadata_update::ID as METADATA_UPDATE_AUTHORITY_PROGRAM_ID;

/// Sourced directly from the pause crate — single source of truth.
/// To update: change declare_id! in pause/src/lib.rs and Anchor.toml.
pub use pause::ID as PAUSABLE_AUTHORITY_PROGRAM_ID;

/// Sourced directly from the freeze crate — single source of truth.
/// To update: change declare_id! in freeze/src/lib.rs and Anchor.toml.
pub use freeze::ID as FREEZE_AUTHORITY_PROGRAM_ID;

/// Sourced directly from the transfer-hook crate — single source of truth.
/// To update: change declare_id! in transfer-hook/src/lib.rs and Anchor.toml.
pub use transfer_hook::ID as TRANSFER_HOOK_PROGRAM_ID;

