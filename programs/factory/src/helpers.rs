use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::AssetClassOwnership;
use crate::state::AssetClassPendingOwner;
use crate::state::Factory;
use crate::state::FactoryPendingManager;

pub fn require_paused(factory: &Factory) -> Result<()> {
    require!(factory.pause, ErrorCode::FactoryNotPaused);
    Ok(())
}

pub fn require_not_paused(factory: &Factory) -> Result<()> {
    require!(!factory.pause, ErrorCode::FactoryPaused);
    Ok(())
}

pub fn verify_manager(factory: &Factory, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(*signer, factory.manager, ErrorCode::NotManager);
    Ok(())
}

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

pub fn verify_owner(asset_class: &AssetClassOwnership, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(*signer, asset_class.owner, ErrorCode::NotOwner);
    Ok(())
}

pub fn verify_pending_owner(pending_owner: &AssetClassPendingOwner, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(
        *signer,
        pending_owner.pending_owner,
        ErrorCode::NotPendingOwner
    );
    Ok(())
}
