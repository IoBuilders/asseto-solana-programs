use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Ei1dX3P7N9cBz2Vs28iB8nsWFqUAWTDicGX7YZSc5HXU");

#[program]
pub mod metadata_update {
    use super::*;

    /// Updates an existing metadata field or adds a new custom key-value pair.
    /// Required lamports for account growth are computed on-chain automatically.
    pub fn update_metadata_field(
        ctx: Context<UpdateMetadata>,
        key: String,
        value: String,
    ) -> Result<()> {
        update_metadata::update_metadata_field(ctx, key, value)
    }

    /// Removes a custom key-value pair from the token metadata.
    /// Core fields (name / symbol / uri) cannot be removed — update them instead.
    pub fn remove_metadata_field(
        ctx: Context<RemoveMetadata>,
        key: String,
        idempotent: bool,
    ) -> Result<()> {
        remove_metadata::remove_metadata_field(ctx, key, idempotent)
    }
}
