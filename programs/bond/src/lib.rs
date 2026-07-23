use anchor_lang::prelude::*;

pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::BondTermsArgs;

declare_id!("8opYXiWzWBrUEr5vtcvaX1ybzYaMKrndxkW1U9Patk46");

#[program]
pub mod bond {
    use super::*;

    pub fn update_bond_terms(ctx: Context<UpdateBondTerms>, args: BondTermsArgs) -> Result<()> {
        update_bond_terms::update_bond_terms(ctx, args)
    }
}
