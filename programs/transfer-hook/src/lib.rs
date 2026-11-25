use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("2qjsucJfrjP93FCwnYjc9EjYzYS8u31eWHhQo1jR9pcg");

#[program]
pub mod transfer_hook {
    use super::*;

    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
        transfer_hook_execute_enabled: bool,
    ) -> Result<()> {
        initialize_extra_account_meta_list::initialize_extra_account_meta_list(
            ctx,
            transfer_hook_execute_enabled,
        )
    }

    pub fn set_deactivated(ctx: Context<SetDeactivated>) -> Result<()> {
        set_deactivated::set_deactivated(ctx)
    }

    pub fn set_freeze(
        ctx: Context<SetFreeze>,
        fully_frozen: bool,
        frozen_balance: u64,
    ) -> Result<()> {
        set_freeze::set_freeze(ctx, fully_frozen, frozen_balance)
    }

    pub fn set_transfer_mode(ctx: Context<SetTransferMode>, transfer_mode: u8) -> Result<()> {
        set_transfer_mode::set_transfer_mode(ctx, transfer_mode)
    }

    pub fn set_in_control_list(
        ctx: Context<SetInControlList>,
        in_control_list: bool,
    ) -> Result<()> {
        set_in_control_list::set_in_control_list(ctx, in_control_list)
    }

    // Discriminator = sha256("spl-transfer-hook-interface:execute")[..8] — see
    // docs/transfer-hook.md ("Discriminator") for the full derivation.
    #[instruction(discriminator = &[105, 37, 101, 197, 75, 251, 102, 26])]
    pub fn execute<'info>(ctx: Context<'info, Execute<'info>>, amount: u64) -> Result<()> {
        execute::execute(ctx, amount)
    }
}
