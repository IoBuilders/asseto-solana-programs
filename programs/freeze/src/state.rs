use anchor_lang::prelude::*;

/// On-chain marker created when a specific token account is frozen at the token level.
/// Seeds: `["frozen_account", mint, account]` — present if and only if the account
/// has been frozen by the deployer via the `freeze_account` management instruction.
#[account]
#[derive(InitSpace)]
pub struct FrozenAccountStatus {
    pub bump: u8,
}

/// On-chain marker storing the frozen balance for a specific token account.
/// Seeds: `["frozen_balance", mint, account]` — created or updated by the
/// `partially_freeze_account` management instruction.
#[account]
#[derive(InitSpace)]
pub struct FrozenBalance {
    pub balance: u64,
    pub bump: u8,
}
