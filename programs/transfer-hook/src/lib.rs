use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;

use instructions::*;

declare_id!("2qjsucJfrjP93FCwnYjc9EjYzYS8u31eWHhQo1jR9pcg");

#[program]
pub mod transfer_hook {
    use super::*;

    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        initialize_extra_account_meta_list::initialize_extra_account_meta_list(ctx)
    }

    // Discriminator = sha256("spl-transfer-hook-interface:execute")[..8] — see
    // docs/transfer-hook.md ("Discriminator") for the full derivation.
    #[instruction(discriminator = &[105, 37, 101, 197, 75, 251, 102, 26])]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        execute::execute(ctx, amount)
    }
}
