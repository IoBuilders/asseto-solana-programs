use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use common::state::{AssetClassVersion, AssetConfiguration, Roles as RolesCommon};
use common::{
    pda_seeds, pda_utils, require_active, require_functionality, require_not_paused, require_role,
    roles,
};

use crate::errors::ErrorCode;
use crate::events::AccountPartiallyFrozen;
use crate::state::FrozenBalance;
use common::program_ids as constants;

pub fn batch_freeze_account_partial<'info>(
    ctx: Context<'info, BatchFreezeAccountPartial<'info>>,
    balances: Vec<u64>,
) -> Result<()> {
    require!(!balances.is_empty(), ErrorCode::EmptyBatch);
    require!(
        ctx.remaining_accounts.len() == balances.len() * 2,
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
        common::functionalities::FREEZE_PARTIALLY_FREEZE_ACCOUNT,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let authority_key = ctx.accounts.authority.key();
    let space = FrozenBalance::DISCRIMINATOR.len() + FrozenBalance::INIT_SPACE;

    for i in 0..balances.len() {
        let balance = balances[i];
        let account = &ctx.remaining_accounts[i * 2];
        let frozen_balance_pda = &ctx.remaining_accounts[i * 2 + 1];
        let account_key = account.key();

        // ── Verify the client supplied the canonical PDA for this account ────
        let frozen_balance_seeds = pda_seeds::frozen_balance_seeds(&mint_key, &account_key);
        let (expected_pda, bump) =
            Pubkey::find_program_address(&frozen_balance_seeds, ctx.program_id);
        require_keys_eq!(
            frozen_balance_pda.key(),
            expected_pda,
            ErrorCode::FrozenBalancePdaMismatch
        );

        // ── Create the PDA on the first call; overwrite on subsequent calls ──
        if frozen_balance_pda.data_is_empty() {
            let signer_seeds = pda_utils::build_pda_signer_seeds(frozen_balance_seeds, &bump);

            pda_utils::create_or_adopt_pda(
                &ctx.accounts.authority.to_account_info(),
                &frozen_balance_pda.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                ctx.program_id,
                space,
                signer_seeds.as_slice(),
            )?;
        }

        let mut data = frozen_balance_pda.try_borrow_mut_data()?;
        let mut cursor = std::io::Cursor::new(data.as_mut());
        FrozenBalance { balance, bump }.try_serialize(&mut cursor)?;
        drop(data);

        emit_cpi!(AccountPartiallyFrozen {
            mint: mint_key,
            account: account_key,
            frozen_balance: balance,
            operator: authority_key,
        });
    }

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct BatchFreezeAccountPartial<'info> {
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

    pub system_program: Program<'info, System>,
}
