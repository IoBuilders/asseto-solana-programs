use anchor_lang::prelude::*;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};
use common::{
    pda_seeds, pda_utils, require_active, require_functionality, require_not_paused, require_role,
    roles,
};

use crate::errors::ErrorCode;
use crate::events::AccountPartialFreezeRemoved;
use crate::state::load_freeze_state;
use common::program_ids as constants;

pub fn batch_unfreeze_account_partial<'info>(
    ctx: Context<'info, BatchUnfreezeAccountPartial<'info>>,
) -> Result<()> {
    require!(!ctx.remaining_accounts.is_empty(), ErrorCode::EmptyBatch);
    require!(
        ctx.remaining_accounts.len() % 2 == 0,
        ErrorCode::InvalidRemainingAccounts
    );

    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_FREEZE_MANAGER,
    )?;

    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::FREEZE_REMOVE_PARTIAL_FREEZE,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let authority_key = ctx.accounts.authority.key();
    let authority_info = ctx.accounts.authority.to_account_info();

    for i in 0..ctx.remaining_accounts.len() / 2 {
        let account = &ctx.remaining_accounts[i * 2];
        let freeze_state_pda = &ctx.remaining_accounts[i * 2 + 1];
        let account_key = account.key();

        // ── Verify the client supplied the canonical PDA for this account ────
        let (expected_pda, _bump) = Pubkey::find_program_address(
            &pda_seeds::freeze_state_seeds(&mint_key, &account_key),
            ctx.program_id,
        );
        require_keys_eq!(
            freeze_state_pda.key(),
            expected_pda,
            ErrorCode::FreezeStatePdaMismatch
        );

        let mut freeze_state =
            load_freeze_state(freeze_state_pda)?.ok_or(ErrorCode::AccountNotPartiallyFrozen)?;
        require!(
            freeze_state.is_partially_frozen(),
            ErrorCode::AccountNotPartiallyFrozen
        );
        freeze_state.frozen_balance = 0;

        if freeze_state.is_empty() {
            pda_utils::close_pda(freeze_state_pda, &authority_info)?;
        } else {
            pda_utils::serialize_pda(freeze_state_pda, &freeze_state)?;
        }

        emit_cpi!(AccountPartialFreezeRemoved {
            mint: mint_key,
            account: account_key,
            operator: authority_key,
        });
    }

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct BatchUnfreezeAccountPartial<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, RolesCommon>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: Read-only; validated by require_not_paused (checks the Pausable extension).
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    #[account(
        seeds = [
            pda_seeds::ASSET_CLASS_VERSION,
            &asset_configuration_pda.asset_class_config_id.to_le_bytes(),
            &asset_configuration_pda.asset_class_version_id.to_le_bytes()
        ],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,
}
