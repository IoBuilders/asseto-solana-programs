use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::NominalValuePublishType;

pub use common::program_ids::*;

declare_id!("DJSxxL9WJkag9gCifqQs5EBD4uow9beP8CyDaZDj2rLL");

#[program]
pub mod nominal_value {
    use super::*;

    pub fn initialize_nominal_value(
        ctx: Context<InitializeNominalValue>,
        nominal_value_decimals: u8,
        nominal_value_currency: [u8; 3],
        nominal_value_publish_type: NominalValuePublishType,
    ) -> Result<()> {
        initialize_nominal_value::initialize_nominal_value(
            ctx,
            nominal_value_decimals,
            nominal_value_currency,
            nominal_value_publish_type,
        )
    }

    pub fn publish_nominal_value(
        ctx: Context<WriteNominalValue>,
        nominal_value: u128,
        effective_datetime: i64,
    ) -> Result<()> {
        write_nominal_value::publish_nominal_value(ctx, nominal_value, effective_datetime)
    }

    pub fn republish_nominal_value(
        ctx: Context<WriteNominalValue>,
        nominal_value: u128,
        effective_datetime: i64,
    ) -> Result<()> {
        write_nominal_value::republish_nominal_value(ctx, nominal_value, effective_datetime)
    }
}
