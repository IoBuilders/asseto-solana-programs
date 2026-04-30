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
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        instructions::initialize_extra_account_meta_list::initialize_extra_account_meta_list(ctx)
    }

    /// Called by Token-2022 on every transfer via the SPL Transfer Hook Interface.
    ///
    /// Discriminator = sha256("spl-transfer-hook-interface:execute")[..8] = [105, 37, 101, 197, 75, 251, 102, 26].
    /// Accounts (per SPL interface): source, mint, destination, owner, extra_account_meta_list.
    #[instruction(discriminator = &[105, 37, 101, 197, 75, 251, 102, 26])]
    pub fn execute(_ctx: Context<Execute>, amount: u64) -> Result<()> {
        msg!("transfer-hook execute: amount={}", amount);
        Ok(())
    }
}

/// Accounts for the SPL Transfer Hook `Execute` instruction.
///
/// Token-2022 passes exactly these 5 accounts when it invokes the hook during
/// TransferChecked: source, mint, destination, owner, extra_account_meta_list.
/// With 0 extra metas in the ExtraAccountMetaList, nothing is appended beyond index 4.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: Source token account (index 0 per SPL transfer-hook-interface).
    pub source_token: UncheckedAccount<'info>,
    /// CHECK: Mint (index 1).
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Destination token account (index 2).
    pub destination_token: UncheckedAccount<'info>,
    /// CHECK: Source account owner/authority (index 3).
    pub owner: UncheckedAccount<'info>,
    /// CHECK: ExtraAccountMetaList PDA (index 4 — validation state).
    pub extra_account_meta_list: UncheckedAccount<'info>,
}
