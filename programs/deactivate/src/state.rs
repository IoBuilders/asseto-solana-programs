use anchor_lang::prelude::*;

/// On-chain marker created when a mint is deactivated.
/// Seeds: `["deactivate", mint]` — present if and only if the mint has been deactivated.
#[account]
#[derive(InitSpace)]
pub struct DeactivateStatus {
    pub bump: u8,
}

