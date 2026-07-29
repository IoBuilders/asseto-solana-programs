use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use errors::ErrorCode;
use instructions::*;
use state::MaxSupply;

pub use common::program_ids::*;
use common::state::AssetClassVersion;
use std::cell::Ref;

declare_id!("64THHYmfoHeWxbZQYq8yRsQJYydfd7yPa6MzNgebiJLm");

/// Checks that minting `amount_to_mint` more tokens keeps the mint's total
/// supply within the cap recorded in its `max_supply` PDA.
///
/// Returns `Ok(())` if no cap is set (the PDA is absent) or the resulting total
/// supply is within it.
/// Returns `Err(ErrorCode::MaxSupplyExceeded)` if the resulting total supply
/// would exceed the cap.
///
/// Enforcement is deliberately *not* gated on the `CAP_MAX_SUPPLY` functionality
/// bit: that bit gates creating the PDA, so an absent bit already means no cap,
/// and gating here would let a version flip stop enforcing a cap the PDA still
/// records.
pub fn require_within_max_supply(
    mint_account: &AccountInfo,
    max_supply_pda: &AccountInfo,
    asset_class_version: Ref<AssetClassVersion>,
    amount_to_mint: u64,
) -> Result<()> {
    use spl_token_2022_interface::extension::StateWithExtensions;
    use spl_token_2022_interface::state::Mint;

    let enabled = common::is_functionality_enabled(
        asset_class_version,
        common::functionalities::CAP_MAX_SUPPLY,
    )?;

    if max_supply_pda.data_is_empty() {
        if enabled {
            return Err(error!(ErrorCode::MaxSupplyNotSet));
        }
        return Ok(());
    }

    let max_supply = {
        let data = max_supply_pda.try_borrow_data()?;
        MaxSupply::try_deserialize(&mut data.as_ref())?.max_supply
    };

    let total_supply = {
        let mint_data = mint_account.try_borrow_data()?;
        StateWithExtensions::<Mint>::unpack(&mint_data)?.base.supply
    };

    // An overflowing sum necessarily exceeds a `u64` cap, so it reports as
    // `MaxSupplyExceeded` rather than warranting an error of its own.
    let new_total_supply = total_supply
        .checked_add(amount_to_mint)
        .ok_or(ErrorCode::MaxSupplyExceeded)?;

    require!(new_total_supply <= max_supply, ErrorCode::MaxSupplyExceeded);

    Ok(())
}

#[program]
pub mod cap {
    use super::*;

    pub fn set_max_supply(ctx: Context<SetMaxSupply>, max_supply: u64) -> Result<()> {
        instructions::set_max_supply::set_max_supply(ctx, max_supply)
    }
}
