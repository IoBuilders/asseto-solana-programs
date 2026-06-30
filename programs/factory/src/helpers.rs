use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::AssetClassOwnership;
use crate::state::AssetClassPendingOwner;
use crate::state::Factory;
use crate::state::FactoryPendingManager;

/// Errors with `FactoryPaused` if the factory's `pause` flag is set.
///
/// Shared by every instruction that must not run while the factory is paused.
pub fn require_not_paused(factory: &Factory) -> Result<()> {
    require!(!factory.pause, ErrorCode::FactoryPaused);
    Ok(())
}

/// Errors with `NotManager` unless `signer` is the factory's recorded manager.
///
/// Shared by every management instruction gated to the current manager.
pub fn verify_manager(factory: &Factory, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(*signer, factory.manager, ErrorCode::NotManager);
    Ok(())
}

/// Errors with `NotPendingManager` unless `signer` is the factory's recorded pending manager.
///
/// Shared by every management instruction gated to the current pending manager.
pub fn verify_pending_manager(
    pending_manager_factory: &FactoryPendingManager,
    signer: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *signer,
        pending_manager_factory.pending_manager,
        ErrorCode::NotPendingManager
    );
    Ok(())
}

/// Errors with `NotOwner` unless `signer` is the asset class's recorded owner.
///
/// Shared by every instruction gated to the current asset class owner.
pub fn verify_owner(asset_class: &AssetClassOwnership, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(*signer, asset_class.owner, ErrorCode::NotOwner);
    Ok(())
}

/// Errors with `NotPendingOwner` unless `signer` is the asset class's recorded pending owner.
///
/// Shared by every instruction gated to the current pending asset class owner.
pub fn verify_pending_owner(pending_owner: &AssetClassPendingOwner, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(
        *signer,
        pending_owner.pending_owner,
        ErrorCode::NotPendingOwner
    );
    Ok(())
}
