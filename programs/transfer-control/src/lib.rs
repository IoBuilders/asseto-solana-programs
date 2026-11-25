use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
mod registry;
pub mod state;

use instructions::*;
pub use state::TransferMode;

declare_id!("3h92PdZJB7TuCzp6iPDtrJm2k8V7fn5ETYNwCYiYy9Eo");

#[program]
pub mod transfer_control {
    use super::*;

    pub fn initialize(ctx: Context<SetMode>, mode: TransferMode) -> Result<()> {
        initialize::initialize(ctx, mode)
    }

    pub fn add_to_control_list<'info>(ctx: Context<'info, AddToControlList<'info>>) -> Result<()> {
        add_to_control_list::add_to_control_list(ctx)
    }

    pub fn remove_from_control_list<'info>(
        ctx: Context<'info, RemoveFromControlList<'info>>,
    ) -> Result<()> {
        remove_from_control_list::remove_from_control_list(ctx)
    }
}
