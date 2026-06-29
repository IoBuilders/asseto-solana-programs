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

    /// Creates the singleton `factory` PDA, recording `manager` and defaulting
    /// `pause` to `false`. Fails if the PDA already exists.
    pub fn initialize(ctx: Context<Initialize>, manager: Pubkey) -> Result<()> {
        instructions::initialize::initialize(ctx, manager)
    }

    /// Current manager nominates `new_manager` as successor, creating/updating the
    /// `factory_pending_manager` PDA. Callable only by the current manager while
    /// the factory is not paused.
    pub fn nominate_manager(ctx: Context<NominateManager>, new_manager: Pubkey) -> Result<()> {
        instructions::nominate_manager::nominate_manager(ctx, new_manager)
    }

    /// Pending manager accepts the nomination: replaces `factory.manager` and
    /// removes the `factory_pending_manager` PDA. Callable only by the pending
    /// manager while the factory is not paused.
    pub fn accept_nomination(ctx: Context<AcceptNomination>) -> Result<()> {
        instructions::accept_nomination::accept_nomination(ctx)
    }

    /// Current manager cancels the pending nomination, removing the
    /// `factory_pending_manager` PDA. Callable only by the current manager while
    /// the factory is not paused.
    pub fn cancel_nomination(ctx: Context<CancelNomination>) -> Result<()> {
        instructions::cancel_nomination::cancel_nomination(ctx)
    }

    /// Manager creates a new asset class identified by `config_id` and owned by
    /// `owner`, creating its `asset_class_ownership` PDA with `latest_version = 0`.
    /// Callable only by the current manager while the factory is not paused.
    pub fn create_asset_class(
        ctx: Context<CreateAssetClass>,
        config_id: u64,
        owner: Pubkey,
    ) -> Result<()> {
        instructions::create_asset_class::create_asset_class(ctx, config_id, owner)
    }
}
