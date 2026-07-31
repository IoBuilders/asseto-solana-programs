use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

pub use common::program_ids::*;

declare_id!("DzYjHw2JUBT8RdNqT8P5soRxJhmL6obibRUs5sMJ2Khi");

#[program]
pub mod document {
    use super::*;

    pub fn set_document<'info>(
        ctx: Context<'info, SetDocument<'info>>,
        name: [u8; 32],
        uri: String,
        document_hash: [u8; 32],
    ) -> Result<()> {
        set_document::set_document(ctx, name, uri, document_hash)
    }

    pub fn remove_document(ctx: Context<RemoveDocument>, name: [u8; 32]) -> Result<()> {
        remove_document::remove_document(ctx, name)
    }
}
