use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("HCe5Um7ThFBzDSyn256EPQvyr6jy6E66ydzZ5hMta3Tq");

#[program]
pub mod deploy {
    use super::*;

    pub fn deploy_mint(ctx: Context<DeployMint>, params: DeployMintParams) -> Result<()> {
        deploy_mint::deploy_mint(ctx, params)
    }
}
