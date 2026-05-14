use anchor_lang::prelude::*;

pub mod instructions;
pub mod state;

use instructions::*;
use state::BondTermsArgs;

declare_id!("BLA6wUczWivPKBw7wnZbvHfYPxcRWEE2Z5aGRnTdfUcU");

#[program]
pub mod bond {
    use super::*;

    /// Creates the `bond_terms_pda` for the mint on the first call, then
    /// overwrites every field with `args` on each subsequent call.
    ///
    /// Management instruction — only the deployer recorded in `mint_owner_pda`
    /// may call this, and only while the mint is neither paused nor deactivated.
    ///
    /// Other on-chain programs read the stored terms by loading the PDA
    /// themselves via `Account<'info, BondTerms>` constrained by
    /// `seeds::program = bond::ID` — no CPI getter is exposed.
    pub fn update_bond_terms(
        ctx: Context<UpdateBondTerms>,
        args: BondTermsArgs,
    ) -> Result<()> {
        update_bond_terms::update_bond_terms(ctx, args)
    }
}
