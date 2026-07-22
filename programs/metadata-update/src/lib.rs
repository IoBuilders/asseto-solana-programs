use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("iShebeGRBZYSBMQYGAg8DbLnbaW2eDvX1Zt8EG9G1ZV");

#[program]
pub mod metadata_update {
    use super::*;

    pub fn update_metadata_field(
        ctx: Context<UpdateMetadata>,
        key: String,
        value: String,
    ) -> Result<()> {
        update_metadata::update_metadata_field(ctx, key, value)
    }

    pub fn remove_metadata_field(
        ctx: Context<RemoveMetadata>,
        key: String,
        idempotent: bool,
    ) -> Result<()> {
        remove_metadata::remove_metadata_field(ctx, key, idempotent)
    }
}
