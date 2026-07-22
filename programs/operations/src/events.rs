use anchor_lang::prelude::*;

/// Emitted once per successful `burn`, after the tokens have been burned via the
/// permanent delegate and the account has been re-blocked.
#[event]
pub struct ControllerRedemption {
    pub mint: Pubkey,
    /// The controller that authorized the forced redemption.
    pub controller: Pubkey,
    /// The token account the tokens were burned from.
    pub from: Pubkey,
    /// Raw token units burned.
    pub value: u64,
}
