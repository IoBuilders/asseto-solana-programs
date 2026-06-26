use anchor_lang::prelude::*;

/// Singleton configuration PDA for the factory, stored at `["factory"]`.
///
/// Created once by `initialize`; the `init` constraint guarantees a second
/// call fails because the account already exists.
#[account]
#[derive(Debug, InitSpace)]
pub struct Factory {
    /// Account authorised to manage the factory.
    pub manager: Pubkey,
    /// Whether the factory is paused. Defaults to `false` at initialization.
    pub pause: bool,
    /// Bump for the `["factory"]` PDA.
    pub bump: u8,
}
