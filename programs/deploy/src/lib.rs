use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("2XMEMg7FUxWksDRZQU9vtGHHSyKoSaH9bncj1noe38QK");

#[program]
pub mod deploy {
    use super::*;

    /// Deploys a new Token-2022 mint with PermanentDelegate, TransferHook,
    /// MetadataPointer, TokenMetadata, and Pausable extensions.
    /// Each extension authority and the mint authority are distinct PDAs
    /// derived from the mint's public key.
    pub fn deploy_mint(ctx: Context<DeployMint>, params: DeployMintParams) -> Result<()> {
        deploy_mint::deploy_mint(ctx, params)
    }
}
