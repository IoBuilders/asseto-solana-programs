use anchor_lang::prelude::*;

pub mod errors;
pub mod helpers;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("FEY9E77nH7R1gLGNxkhYKchJpB6MgpMrWMhkNXrNhzR5");

#[program]
pub mod factory {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::initialize(ctx)
    }

    pub fn nominate_manager(ctx: Context<NominateManager>, new_manager: Pubkey) -> Result<()> {
        nominate_manager::nominate_manager(ctx, new_manager)
    }

    pub fn accept_nomination(ctx: Context<AcceptNomination>) -> Result<()> {
        accept_nomination::accept_nomination(ctx)
    }

    pub fn cancel_nomination(ctx: Context<CancelNomination>) -> Result<()> {
        cancel_nomination::cancel_nomination(ctx)
    }

    pub fn create_asset_class(
        ctx: Context<CreateAssetClass>,
        config_id: u64,
        owner: Pubkey,
    ) -> Result<()> {
        create_asset_class::create_asset_class(ctx, config_id, owner)
    }

    pub fn nominate_asset_class_owner(
        ctx: Context<NominateAssetClassOwner>,
        config_id: u64,
        new_owner: Pubkey,
    ) -> Result<()> {
        nominate_asset_class_owner::nominate_asset_class_owner(ctx, config_id, new_owner)
    }

    pub fn accept_asset_class_ownership(
        ctx: Context<AcceptAssetClassOwnership>,
        config_id: u64,
    ) -> Result<()> {
        accept_asset_class_ownership::accept_asset_class_ownership(ctx, config_id)
    }

    pub fn cancel_asset_class_ownership(
        ctx: Context<CancelAssetClassOwnership>,
        config_id: u64,
    ) -> Result<()> {
        cancel_asset_class_ownership::cancel_asset_class_ownership(ctx, config_id)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        pause::pause(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        unpause::unpause(ctx)
    }

    pub fn init_asset_class_version(
        ctx: Context<InitAssetClassVersion>,
        config_id: u64,
        version: u64,
    ) -> Result<()> {
        init_asset_class_version::init_asset_class_version(ctx, config_id, version)
    }

    pub fn enable_asset_class_version_functionalities(
        ctx: Context<EnableAssetClassVersionFunctionalities>,
        config_id: u64,
        version: u64,
        functionalities: Vec<u16>,
    ) -> Result<()> {
        enable_asset_class_version_functionalities::enable_asset_class_version_functionalities(
            ctx,
            config_id,
            version,
            functionalities,
        )
    }

    pub fn disable_asset_class_version_functionalities(
        ctx: Context<DisableAssetClassVersionFunctionalities>,
        config_id: u64,
        version: u64,
        functionalities: Vec<u16>,
    ) -> Result<()> {
        disable_asset_class_version_functionalities::disable_asset_class_version_functionalities(
            ctx,
            config_id,
            version,
            functionalities,
        )
    }

    pub fn finalize_asset_class_version(
        ctx: Context<FinalizeAssetClassVersion>,
        config_id: u64,
        version: u64,
    ) -> Result<()> {
        finalize_asset_class_version::finalize_asset_class_version(ctx, config_id, version)
    }
}
