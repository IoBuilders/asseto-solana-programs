use anchor_lang::prelude::*;

/// On-chain marker created when a mint is deactivated.
/// Seeds: `["deactivate", mint]` — present if and only if the mint has been deactivated.
#[account]
pub struct DeactivateStatus {
    pub bump: u8,
}

impl DeactivateStatus {
    pub const LEN: usize = 8 + 1; // discriminator + bump
}
