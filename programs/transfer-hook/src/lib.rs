use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;

use instructions::*;

declare_id!("2qjsucJfrjP93FCwnYjc9EjYzYS8u31eWHhQo1jR9pcg");

#[program]
pub mod transfer_hook {
    use super::*;

    /// Creates and initialises an empty ExtraAccountMetaList PDA for the given mint.
    /// Only callable via CPI from deploy (enforced by `asset_configuration_pda` as Signer).
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        initialize_extra_account_meta_list::initialize_extra_account_meta_list(ctx)
    }

    /// Called by Token-2022 on every transfer via the SPL Transfer Hook Interface.
    ///
    /// Discriminator = sha256("spl-transfer-hook-interface:execute")[..8] = [105, 37, 101, 197, 75, 251, 102, 26].
    /// Accounts (per SPL interface): source, mint, destination, owner, extra_account_meta_list.
    #[instruction(discriminator = &[105, 37, 101, 197, 75, 251, 102, 26])]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        execute::execute(ctx, amount)
    }
}
