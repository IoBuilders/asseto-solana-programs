use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;

use instructions::*;

declare_id!("5j3F89fmVVusjwy9z3Rv5wLaVj4ovhwctQ7TRBsxNghq");

#[program]
pub mod pause {
    use super::*;

    /// Pauses the Token-2022 mint: all minting, burning, and transfers are blocked.
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    pub fn pause(ctx: Context<PauseMint>) -> Result<()> {
        pause_mint::pause(ctx)
    }

    /// Unpauses the Token-2022 mint: resumes normal minting, burning, and transfers.
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    pub fn unpause(ctx: Context<UnpauseMint>) -> Result<()> {
        unpause_mint::unpause(ctx)
    }
}
