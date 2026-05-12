use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;

use instructions::*;


declare_id!("482AUGU4SbYePPHaV7yvXrGEprHhiWSTRBds4Bdr6CPz");

#[program]
pub mod cmtat_transfer_hook {
    use super::*;

    /// Creates and initialises an empty ExtraAccountMetaList PDA for the given mint.
    /// Only callable via CPI from cmtat-deploy (enforced by `mint_owner_pda` as Signer).
    /// `deployer` is baked into the metalist so Token-2022 forwards it to `execute`
    /// on every transfer (used for clearing-mode signer enforcement).
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
        deployer: Pubkey,
    ) -> Result<()> {
        instructions::initialize_extra_account_meta_list::initialize_extra_account_meta_list(
            ctx,
            deployer,
        )
    }

    /// Called by Token-2022 on every transfer via the SPL Transfer Hook Interface.
    ///
    /// Discriminator = sha256("spl-transfer-hook-interface:execute")[..8] = [105, 37, 101, 197, 75, 251, 102, 26].
    /// Accounts (per SPL interface): source, mint, destination, owner, extra_account_meta_list.
    #[instruction(discriminator = &[105, 37, 101, 197, 75, 251, 102, 26])]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        instructions::execute::execute(ctx, amount)
    }
}
