use anchor_lang::prelude::*;

pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("8rds1q4evGug816bswEEmDmJSymq86sq7mgYRcPQP996");

#[program]
pub mod deactivate {
    use super::*;

    /// Deactivates the Token-2022 mint by creating an on-chain marker PDA.
    /// The PDA's existence signals permanent deactivation of the mint.
    /// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
    pub fn deactivate(ctx: Context<Deactivate>) -> Result<()> {
        instructions::deactivate::deactivate(ctx)
    }
}
